# AnyRPC

RPC handling

- Over Any wire(HTTP, WebSocket, Redis, TPC, Bluetooth, Serial, ...)
- Using Any transport(JSON, Messagepack, Protobuf, ...)
- Typed end-to-end!

Why every existing RPC implementation ships with a fixed, builtin Wire and Transport? I dont know!

This aims to fix that, making for a simple, pluggable wrapper for handling RPC calls that could easily be implemented in other languages as well.

## Install

`npm install @kinsi/anyrpc`

## Examples

Obviously these include absolutely no error handling whatsoever but you get the gist

#### WebSocket (Bidirectional)
```ts
import AnyRPC, { type RPCList } from "@kinsi/anyrpc";
import uWebSockets from "uWebSockets.js"

type BackendMethods = RPCList<{
	Foo: {
		call: { baz: number },
		return: number
	}
}>;

type ServiceMethods = RPCList<{
	Bar: {
		call: void;
		return: number;
	}
}>;

// Backend
(() => {
	const app = uWebSockets.App();
	const rpc = new AnyRPC<ServiceMethods, BackendMethods>(null);
	const websockets = new Map<uWebSockets.WebSocket<any>, AnyRPC<ServiceMethods, BackendMethods>>();

	const textDecoder = new TextDecoder();

	app.ws("/wsEndpoint", {
		open(ws) {
			/*
				Subchannels override the method for sending out data, but use the same RPC
				handlers of the parent
			*/
			websockets.set(ws, rpc.getSubChannel(x => ws.send(JSON.stringify(x))));
		},
		message(ws, message) {
			websockets.get(ws).tryConsume(JSON.parse(textDecoder.decode(message)));
		},
		close(ws) {
			websockets.delete(ws);
		}
	});

	app.listen(3000, x => null);

	rpc.setHandler("Foo", data => {
		return data.baz + 1;
	});

	setInterval(async () => {
		for(const channel of websockets.values())
			console.log("Response from Service:", await channel.call("Bar"));
	}, 5000);
});

// Service
(() => {
	const ws = new WebSocket("0.0.0.0:3000/wsEndpoint");
	const rpc = new AnyRPC<BackendMethods, ServiceMethods>(x => ws.send(JSON.stringify(x)));

	ws.onmessage = (event) => rpc.tryConsume(JSON.parse(event.data));

	rpc.setHandler("Bar", () => {
		return 0xdeadbeef;
	});

	rpc.call("Foo", {baz: 41}).then(x => console.log("Answer to everything:", x));
});
```


#### HTTP (Unidirectional, Backend can only be called, not make calls itself)

```ts
import AnyRPC, { type RPC } from "@kinsi/anyrpc";
import uWebSockets from "uWebSockets.js"

type BackendMethods = RPCList<{
	Foo: {
		call: { baz: number };
		return: number;
	}
}>;

// Backend
(() => {
	const rpc = new AnyRPC<null, BackendMethods>(null);

	uWebSockets.App().post("/RPC/:method", (res, req) => {
		// For sake of simplicity, I'm using a url param here
		rpc.tryConsume(JSON.parse(req.getQuery("call")), cb => res.end(JSON.stringify(cb)));
	}).listen(3000, x => null);

	rpc.setHandler("Foo", async(data) => {
		return data.baz + 1;
	});
});

// Client
(() => {
	const rpc = new AnyRPC<BackendMethods, null>(x => {
		return fetch(`0.0.0.0:3000/RPC/${x.method}?` + new URLSearchParams({
			call: JSON.stringify(x)
		}))
	});

	rpc.call("Foo", {baz: 41}).then(x => console.log("Answer to everything:", x));
});
```