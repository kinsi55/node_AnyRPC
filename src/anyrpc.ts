export interface RPC {
	name: string;
	call: any;
	return: any;
	auxCallDataOverride?: any;
}

export type RPCList<T extends Record<string, Omit<RPC, "name">>, D = never> = {
  [K in keyof T]: {
    name: K & string;
    call: T[K]["call"];
    return: T[K]["return"];
		auxCallData: "auxCallDataOverride" extends keyof T[K] ? T[K]["auxCallDataOverride"] : D;
  };
};

export interface AnyRPCMessage {
	anyRpcCallId: number;
}

export interface WrappedCall<D = any> extends AnyRPCMessage {
	method: string;
	message: any;
	/**
	 * When passing a deserialized WrappedCall to tryConsume, this value is passed as the 2nd
	 * argument to the RPC handler. This allows you to pass additional values needed in the handler
	 * like a session object
	 */
	auxCallData?: D;
}

export interface WrappedResponse extends AnyRPCMessage {
	responseOk: boolean;
	response: any;
}

type RPCHandler<T extends RPC, D = any> = (data: T["call"], auxData: D) => T["return"] | Promise<T["return"]>;
type MessageSender = (msg: WrappedCall | WrappedResponse) => Promise<any> | any;
type keyofStr<T> = Extract<keyof T, string>;

let msgNum = 0;

const KV = function() {};
KV.prototype = Object.create(null);

const FIRE_AND_FORGET_CALLID = -1;
export const DATA_UNCONSUMED = Symbol("DATA_UNCONSUMED");

export default class AnyRPC<Calls extends RPCList<any>, Handlers extends RPCList<any, D>, D = never> {
	#sendMethod: MessageSender;

	#responseHandlers = new Map() as Map<number, (x: WrappedResponse) => any>;
	// @ts-ignore
	#rpcHandlers: {[key: string]: RPCHandler<any>} = new KV();
	#handlerForward: AnyRPC<any, Handlers> | undefined;

	constructor(sendMethod?: (msg: WrappedCall) => any) {
		this.#sendMethod = sendMethod as MessageSender;
	}

	getSubChannel<Calls extends RPCList<any>>(sendMethod: (msg: WrappedCall) => any): AnyRPC<Calls, Handlers> {
		const sub = new AnyRPC<Calls, Handlers>(sendMethod);

		sub.#handlerForward = this;
		sub.#rpcHandlers = this.#rpcHandlers;

		return sub;
	}

	async #call<T extends RPC>(wrappedMsg: WrappedCall, timeoutMs: number) : Promise<T["return"]> {
		const callId = wrappedMsg.anyRpcCallId;

		if(callId === FIRE_AND_FORGET_CALLID)
			return this.#sendMethod(wrappedMsg);

		const p = new Promise((res, rej) => {
			const timeout = setTimeout(() => callback({
				response: "Request timed out",
				responseOk: false,
				anyRpcCallId: -1
			}), timeoutMs);

			const callback = (msg: WrappedResponse) => {
				clearTimeout(timeout);

				this.#responseHandlers.delete(callId);

				if(!msg.responseOk)
					return rej(new Error(msg.response));

				res(msg.response);
				return true;
			};

			this.#responseHandlers.set(callId, callback);
		});

		await this.#sendMethod(wrappedMsg);

		return p as Promise<T["return"]>;
	}

	async call<T extends keyofStr<Calls>>(
		def: T, data: Calls[T]["call"] = null, timeoutMs = 5e3
	) : Promise<Calls[T]["return"]> {
		// I would hope that past this point, every possible dangling handler has timed out
		if(msgNum >= Number.MAX_SAFE_INTEGER)
			msgNum = 0;

		return this.#call({
			anyRpcCallId: ++msgNum,
			method: def,
			message: data
		}, timeoutMs);
	}

	async callWithoutResponse<T extends keyofStr<Calls>>(
		def: T, data: Calls[T]["call"] = null, timeoutMs = 5e3
	) : Promise<Calls[T]["return"]> {
		return this.#call({
			anyRpcCallId: FIRE_AND_FORGET_CALLID,
			method: def,
			message: data
		}, timeoutMs);
	}

	/**
	 * Helper method that will "forward" incoming calls of the defined type to the given target
	 * AnyRPC instance and then return back its return to the original caller.
	 *
	 * Given auxCallData was set on the WrappedCall, it is NOT forwarded. In those cases it should
	 * be part of the message itself
	 */
	setForward<TargetHandlers extends RPCList<any>, T extends keyofStr<TargetHandlers>>(
		target: AnyRPC<TargetHandlers, any>, def: T, timeoutMs = 5e3
	) {
		this.setHandler(def, (data) => target.call<T>(def, data, timeoutMs));
	}

	setHandler<T extends keyofStr<Handlers>>(def: T, handler: RPCHandler<Handlers[T], Handlers[T]["auxCallData"]>) {
		if(this.#handlerForward)
			throw new Error("Cannot add Handler to Sub-Channel");

		this.#rpcHandlers[def] = handler;
	}

	tryConsume(message: AnyRPCMessage, responseHandlerOverride?: MessageSender): typeof DATA_UNCONSUMED | boolean | Promise<boolean> {
		/*
			To try and avoid collisions, whenever we receive a message ourselves we set our message id to
			whatever we were sent incase the same message channel is shared across multiple different
			senders / receivers
		*/
		if(message.anyRpcCallId > 0)
			msgNum = message.anyRpcCallId + 1;

		if((message as WrappedCall).method) {
			return this.#handleCall(message as WrappedCall, responseHandlerOverride ?? this.#sendMethod);
		} else if((message as WrappedResponse).responseOk !== undefined) {
			return this.#handleResponse(message as WrappedResponse);
		}
		return DATA_UNCONSUMED;
	}

	tryConsumeCall(message: WrappedCall, responseHandlerOverride?: MessageSender): typeof DATA_UNCONSUMED | Promise<boolean> {
		if(!message.method)
			return DATA_UNCONSUMED;

		return this.#handleCall(message, responseHandlerOverride ?? this.#sendMethod);
	}

	tryConsumeResponse(message: WrappedResponse): typeof DATA_UNCONSUMED | boolean {
		if(!message.responseOk !== undefined)
			return DATA_UNCONSUMED;

		return this.#handleResponse(message);
	}

	async #handleCall(call: WrappedCall, sender: MessageSender): Promise<boolean> {
		const response: WrappedResponse = {
			anyRpcCallId: call.anyRpcCallId,
			responseOk: false,
			response: "Method not found"
		};

		const handler = this.#rpcHandlers[call.method];

		if(handler) {
			try {
				response.responseOk = true;
				response.response = await handler(call.message, call.auxCallData);
			} catch(ex) {
				response.response = (ex as Error)?.message || ex
			}
		}

		if(call.anyRpcCallId === FIRE_AND_FORGET_CALLID)
			return true;

		return sender(response);
	}

	#handleResponse(response: WrappedResponse): boolean {
		return this.#responseHandlers.get(response.anyRpcCallId)?.(response) ?? false;
	}
}