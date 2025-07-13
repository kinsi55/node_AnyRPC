export interface RPC {
	name: string;
	call: any;
	return: any;
}

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

class AnyRPC {
	#sendMethod: MessageSender;

	#responseHandlers = new Map() as Map<number, (x: WrappedResponse) => any>;
	// @ts-ignore
	#rpcHandlers: {[key: string]: RPCHandler<any>} = new KV();
	#handlerForward: AnyRPC | undefined;

	constructor(sendMethod: (msg: WrappedCall) => any) {
		this.#sendMethod = sendMethod.bind(this) as MessageSender;
	}

	getSubChannel(sendMethod: (msg: WrappedCall) => any): AnyRPC {
		const sub = new AnyRPC(sendMethod);

		sub.#handlerForward = this;
		sub.#rpcHandlers = this.#rpcHandlers;

		return sub;
	}

	async #call<T extends RPC>(wrappedMsg: WrappedCall, timeoutMs: number) : Promise<T["return"]> {
		if(wrappedMsg.anyRpcCallId === FIRE_AND_FORGET_CALLID)
			return this.#sendMethod(wrappedMsg);

		const p = new Promise((res, rej) => {
			const timeout = setTimeout(() => callback({
				response: "Request timed out",
				responseOk: false,
				anyRpcCallId: -1
			}), timeoutMs);

			const callback = (msg: WrappedResponse) => {
				clearTimeout(timeout);

				this.#responseHandlers.delete(msgNum);

				if(!msg.responseOk)
					return rej(new Error(msg.response));

				res(msg.response);
				return true;
			};

			this.#responseHandlers.set(msgNum, callback);
		});

		await this.#sendMethod(wrappedMsg);

		return p as Promise<T["return"]>;
	}

	async call<T extends RPC>(def: T["name"], data: T["call"] = null, timeoutMs = 5e3) : Promise<T["return"]> {
		return this.#call({
			anyRpcCallId: msgNum++,
			method: def,
			message: data
		}, timeoutMs);
	}

	async callWithoutResponse<T extends RPC>(def: T["name"], data: T["call"] = null, timeoutMs = 5e3) : Promise<void> {
		return this.#call({
			anyRpcCallId: FIRE_AND_FORGET_CALLID,
			method: def,
			message: data
		}, timeoutMs);
	}

	setForward<T extends RPC>(def: T["name"], target: AnyRPC, timeoutMs = 5e3) {
		if(this.#handlerForward)
			throw new Error("Cannot add Forward to Sub-Channel");

		this.#rpcHandlers[def] = (data) => {
			return target.call<T>(def, data, timeoutMs);
		};
	}

	setHandler<T extends RPC>(def: T["name"], handler: RPCHandler<T>) {
		if(this.#handlerForward)
			throw new Error("Cannot add Handler to Sub-Channel");

		this.#rpcHandlers[def] = handler;
	}

	tryConsume(message: AnyRPCMessage, responseHandlerOverride?: MessageSender): typeof DATA_UNCONSUMED | boolean | Promise<boolean> {
		if((message as WrappedCall).method) {
			return this.#handleCall(message as WrappedCall, responseHandlerOverride ?? this.#sendMethod);
		} else if((message as WrappedResponse).responseOk !== undefined) {
			return this.#handleResponse(message as WrappedResponse);
		}
		return DATA_UNCONSUMED;
	}

	async #handleCall(call: WrappedCall, sender: MessageSender): Promise<boolean> {
		const response: WrappedResponse = {
			anyRpcCallId: call.anyRpcCallId,
			responseOk: false,
			response: "Method not found"
		};

		const handler = this.#rpcHandlers[call.message];

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