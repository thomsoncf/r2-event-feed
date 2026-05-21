import { DurableObject } from "cloudflare:workers";
import type { Env, FeedEvent } from "./types";

interface ClientMeta {
	subscriptionId: number;
	subscriberId: string;
}

/**
 * Broadcaster Durable Object.
 *
 * Owns a set of connected SSE / WebSocket clients (one DO per shard).
 * Uses Hibernatable WebSockets so idle connections cost nothing.
 *
 * The fanout worker calls `broadcast(event)` on each shard that has at least
 * one connected client.
 */
export class Broadcaster extends DurableObject<Env> {
	private sseClients = new Map<WritableStreamDefaultWriter<Uint8Array>, ClientMeta>();

	override async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/internal/sse") {
			// Worker has already validated the JWT and read D1. The actual
			// subscriberId / subscriptionId are passed via headers.
			const subscriberId = req.headers.get("X-Feed-Subscriber") ?? "";
			const subscriptionIdStr = req.headers.get("X-Feed-Subscription") ?? "0";
			const subscriptionId = Number.parseInt(subscriptionIdStr, 10) || 0;

			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
			const writer = writable.getWriter();
			this.sseClients.set(writer, { subscriberId, subscriptionId });

			// Send a comment line immediately so the client knows we're up.
			await writer.write(new TextEncoder().encode(`:ok\n\n`));

			// Clean up when the client disconnects.
			req.signal.addEventListener("abort", () => {
				this.sseClients.delete(writer);
				try {
					writer.close();
				} catch {}
			});

			return new Response(readable, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				},
			});
		}

		if (url.pathname === "/internal/ws") {
			if (req.headers.get("Upgrade") !== "websocket") {
				return new Response("upgrade required", { status: 426 });
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
			const subscriberId = req.headers.get("X-Feed-Subscriber") ?? "";
			const subscriptionIdStr = req.headers.get("X-Feed-Subscription") ?? "0";
			const subscriptionId = Number.parseInt(subscriptionIdStr, 10) || 0;

			this.ctx.acceptWebSocket(server, [`sub:${subscriberId}`, `id:${subscriptionId}`]);
			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response("not found", { status: 404 });
	}

	/**
	 * Called by the fanout queue handler. Fans out to every connected client.
	 */
	async broadcast(event: FeedEvent): Promise<{ delivered: number }> {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		const wsPayload = JSON.stringify(event);

		// SSE clients
		const sseEncoded = new TextEncoder().encode(payload);
		const sseDead: WritableStreamDefaultWriter<Uint8Array>[] = [];
		const sseWrites = Array.from(this.sseClients.keys()).map(async (w) => {
			try {
				await w.write(sseEncoded);
			} catch {
				sseDead.push(w);
			}
		});

		// WebSocket clients (hibernatable — survives across DO restarts)
		const sockets = this.ctx.getWebSockets();
		for (const sock of sockets) {
			try {
				sock.send(wsPayload);
			} catch {
				try {
					sock.close(1011, "send failed");
				} catch {}
			}
		}

		await Promise.all(sseWrites);
		for (const w of sseDead) this.sseClients.delete(w);

		return { delivered: this.sseClients.size + sockets.length };
	}

	override async webSocketMessage(ws: WebSocket, _msg: ArrayBuffer | string): Promise<void> {
		// Clients are read-only; we ignore inbound messages but keep the
		// callback so hibernation works.
		ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void> {
		console.log("ws close", { code, reason, wasClean });
		try {
			ws.close(code, "client closed");
		} catch {}
	}
}
