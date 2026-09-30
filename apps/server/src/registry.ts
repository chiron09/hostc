import { DurableObject } from "cloudflare:workers";

/**
 * Global registry of tunnel lifecycle state for the admin UI.
 *
 * Only lifecycle events touch it (create, connect, disconnect, expire): a few
 * writes per connection, never per request, so idle tunnels stay asleep.
 * Every failure here is contained by the caller: the registry is best effort
 * and must never break a tunnel.
 */

export type RegistryEntry = {
	id: string;
	createdAt: number;
	connectedAt: number | null;
	disconnectedAt: number | null;
};

type LifecycleEvent = "created" | "connected" | "disconnected" | "gone";

const PREFIX = "tunnel:";
const MAX_ENTRIES = 1000;
/** Entries untouched for this long are pruned on list, so a missed "gone" report cannot pile up. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class Registry extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/list") {
				return Response.json({ tunnels: await this.list() });
			}
			if (request.method === "POST") {
				const body = (await request.json()) as { id?: unknown };
				const id = typeof body.id === "string" ? body.id : "";
				if (!id) {
					return Response.json({ error: "id required" }, { status: 400 });
				}
				const event = url.pathname.slice(1) as LifecycleEvent;
				await this.apply(event, id);
				return Response.json({ ok: true });
			}
			return Response.json({ error: "Not found" }, { status: 404 });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	}

	private async apply(event: LifecycleEvent, id: string): Promise<void> {
		const key = PREFIX + id;
		const store = this.ctx.storage;
		if (event === "created") {
			const entry: RegistryEntry = { id, createdAt: Date.now(), connectedAt: null, disconnectedAt: null };
			await store.put(key, entry);
			return;
		}
		const entry = await store.get<RegistryEntry>(key);
		if (!entry) {
			// A "gone" for an unknown tunnel (never reported as created) still needs no entry.
			if (event === "gone") {
				await store.delete(key);
			}
			return;
		}
		if (event === "connected") {
			entry.connectedAt = Date.now();
			entry.disconnectedAt = null;
		} else if (event === "disconnected") {
			entry.disconnectedAt = Date.now();
		} else if (event === "gone") {
			await store.delete(key);
			return;
		}
		await store.put(key, entry);
	}

	private async list(): Promise<RegistryEntry[]> {
		const store = this.ctx.storage;
		const entries = await store.list<RegistryEntry>({ prefix: PREFIX, limit: MAX_ENTRIES });
		const now = Date.now();
		const stale: string[] = [];
		const alive: RegistryEntry[] = [];
		for (const [key, entry] of entries) {
			const last = entry.disconnectedAt ?? entry.connectedAt ?? entry.createdAt;
			if (now - last > MAX_AGE_MS) {
				stale.push(key);
			} else {
				alive.push(entry);
			}
		}
		if (stale.length > 0) {
			await store.delete(stale);
		}
		return alive.sort((a, b) => b.createdAt - a.createdAt);
	}
}
