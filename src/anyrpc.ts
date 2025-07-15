export interface RPC {
	name: string;
	call: any;
	return: any;
}

export type RPCList<T extends Record<string, { call: any; return: any }>> = {
  [K in keyof T]: {
    name: K & string;
    call: T[K]["call"];
    return: T[K]["return"];
  };
};

interface AnyRPCMessage {
	anyRpcCallId: number;
}

interface WrappedCall extends AnyRPCMessage {
	method: string;
	message: any;
}

interface WrappedResponse extends AnyRPCMessage {
	responseOk: boolean;
	response: any;
}

type RPCHandler<T extends RPC> = (data: T["call"]) => T["return"] | Promise<T["return"]>;
type MessageSender = (msg: WrappedCall | WrappedResponse) => Promise<any> | any;

let msgNum = 1;

const KV = function() {};
KV.prototype = Object.create(null);

const FIRE_AND_FORGET_CALLID = -1;
const DATA_UNCONSUMED = Symbol("DATA_UNCONSUMED");

type keyofStr<T> = Extract<keyof T, string>;

class AnyRPC<Calls extends RPCList<any>, Handlers extends RPCList<any>> {
	#sendMethod: MessageSender;

	#responseHandlers = new Map() as Map<number, (x: WrappedResponse) => any>;
	// @ts-ignore
	#rpcHandlers: {[key: string]: RPCHandler<any>} = new KV();
	#handlerForward: AnyRPC<any, Handlers> | undefined;

	constructor(sendMethod: (msg: WrappedCall) => any) {
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
		if(msgNum >= Number.MIN_SAFE_INTEGER)
			msgNum = 1;

		return this.#call({
			anyRpcCallId: msgNum++,
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

	setForward<TargetHandlers extends RPCList<any>, T extends keyofStr<TargetHandlers>>(
		def: T, target: AnyRPC<TargetHandlers, any>, timeoutMs = 5e3
	) {
		if(this.#handlerForward)
			throw new Error("Cannot add Forward to Sub-Channel");

		this.#rpcHandlers[def] = (data) => {
			return target.call<T>(def, data, timeoutMs);
		};
	}

	setHandler<T extends keyofStr<Handlers>>(def: T, handler: RPCHandler<Handlers[T]>) {
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
		if(typeof message.anyRpcCallId === "number")
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

		if(call.anyRpcCallId === FIRE_AND_FORGET_CALLID)
			return true;

		if(handler) {
			try {
				response.responseOk = true;
				response.response = await handler(call.message);
			} catch(ex) {
				response.response = (ex as Error)?.message || ex
			}
		}

		return sender(response);
	}

	#handleResponse(response: WrappedResponse): boolean {
		return this.#responseHandlers.get(response.anyRpcCallId)?.(response) ?? false;
	}
}

export default AnyRPC;

export {DATA_UNCONSUMED};