import {
	API_TUNNELS_PATH,
	type CreateTunnelResponse,
	isSubdomainLabel,
	isTunnelId,
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
	type RegisterAccountResponse,
	TUNNEL_ID_ALPHABET,
	TUNNEL_ID_LENGTH,
} from "@hostc/protocol";

import { Accounts } from "./accounts.ts";
import { ADMIN_HTML } from "./admin.ts";
import { errorResponse, pages } from "./pages.ts";
import { Registry } from "./registry.ts";
import { signConnectToken, verifyConnectToken } from "./token.ts";
import { CONNECT_URL, KICK_URL, Tunnel } from "./tunnel.ts";

export { Tunnel, Registry, Accounts };

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const tunnelId = tunnelLabelFromHost(url.host, env.TUNNEL_DOMAIN);
		if (tunnelId !== undefined) {
			return handleTunnelRequest(request, env, tunnelId);
		}

		if (url.pathname === "/api/health") {
			return Response.json({ ok: true });
		}
		if (url.pathname === "/admin") {
			return new Response(ADMIN_HTML, {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			});
		}
		if (url.pathname === "/api/admin/tunnels" || url.pathname.startsWith("/api/admin/tunnels/")) {
			return handleAdmin(request, env, url);
		}
		if (url.pathname.startsWith(API_TUNNELS_PATH)) {
			// Checked before routing, so clients on any older protocol (including their old paths)
			// get the 426 they know how to show as "please upgrade".
			const mismatch = checkProtocol(request);
			if (mismatch) {
				return mismatch;
			}
		}
		if (url.pathname === "/api/accounts") {
			return request.method === "POST" ? registerAccount(request, env) : jsonError(405, "Method not allowed");
		}
		if (url.pathname === API_TUNNELS_PATH) {
			return request.method === "POST" ? createTunnel(request, env, url) : jsonError(405, "Method not allowed");
		}
		const connect = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/connect$/);
		if (connect?.[1]) {
			return connectTunnel(request, env, connect[1]);
		}
		return jsonError(404, "Not found");
	},
} satisfies ExportedHandler<Env>;

/**
 * The label under the tunnel domain, if the host is under it. Accepts any
 * valid DNS label: anonymous tunnels use random 12-char ids, fixed-subdomain
 * accounts use their bound name. Returns null only for an empty/invalid label.
 */
export function tunnelLabelFromHost(host: string, tunnelDomain: string): string | null | undefined {
	const suffix = `.${tunnelDomain.toLowerCase()}`;
	const normalized = host.toLowerCase();
	if (!normalized.endsWith(suffix)) {
		return undefined;
	}
	const label = normalized.slice(0, -suffix.length);
	if (!label) {
		return null;
	}
	// Forward any label to the DO; it decides whether a tunnel is alive there.
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) ? label : null;
}

function handleTunnelRequest(request: Request, env: Env, label: string | null): Promise<Response> | Response {
	if (label === null) {
		return errorResponse(request, pages.notFound);
	}
	return env.TUNNEL.getByName(label).fetch(request);
}

// ---------------------------------------------------------------------------
// Admin API

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
	if (!env.ADMIN_TOKEN) {
		// Without a configured admin token the whole surface stays closed.
		return jsonError(404, "Not found");
	}
	if (!(await adminAuthorized(request, env.ADMIN_TOKEN))) {
		return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
	}
	if (request.method === "GET" && url.pathname === "/api/admin/tunnels") {
		return listTunnels(env);
	}
	const kick = url.pathname.match(/^\/api\/admin\/tunnels\/([^/]+)\/kick$/);
	if (kick?.[1] && request.method === "POST") {
		return kickTunnel(env, kick[1]);
	}
	return jsonError(404, "Not found");
}

/** Constant-time comparison, so response timing does not reveal the token prefix. */
async function adminAuthorized(request: Request, expected: string): Promise<boolean> {
	const provided = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
	if (!provided) {
		return false;
	}
	const a = new TextEncoder().encode(provided.padEnd(64, "\0").slice(0, 64)).buffer as ArrayBuffer;
	const b = new TextEncoder().encode(expected.padEnd(64, "\0").slice(0, 64)).buffer as ArrayBuffer;
	return crypto.subtle.timingSafeEqual(a, b);
}

async function listTunnels(env: Env): Promise<Response> {
	const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
	const response = await registry.fetch("https://registry/list");
	if (!response.ok) {
		return jsonError(502, "Registry unavailable");
	}
	const body = (await response.json()) as { tunnels: { id: string; createdAt: number; connectedAt: number | null; disconnectedAt: number | null }[] };
	const tunnels = body.tunnels.map((entry) => ({
		...entry,
		url: `https://${entry.id}.${env.TUNNEL_DOMAIN.split(":")[0]}`,
	}));
	return Response.json({ tunnels });
}

async function kickTunnel(env: Env, id: string): Promise<Response> {
	if (!isTunnelId(id)) {
		return Response.json({ error: "Tunnel not found" }, { status: 404 });
	}
	const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
	const response = await registry.fetch("https://registry/gone", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	});
	if (!response.ok) {
		return jsonError(502, "Registry unavailable");
	}
	// Tells the tunnel to drop its client and expire; best effort after the registry update.
	await env.TUNNEL.getByName(id).fetch(new Request(KICK_URL, { method: "POST" })).catch(() => undefined);
	return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Accounts (fixed subdomains)

async function registerAccount(request: Request, env: Env): Promise<Response> {
	const client = request.headers.get("cf-connecting-ip") ?? "local";
	const { success } = await env.CREATE_LIMIT.limit({ key: `register:${client}` });
	if (!success) {
		return jsonError(429, "Too many accounts created. Try again in a minute.");
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonError(400, "Invalid JSON body");
	}
	const { subdomain } = (body ?? {}) as { subdomain?: unknown };
	if (typeof subdomain !== "string" || !isSubdomainLabel(subdomain)) {
		return jsonError(400, "Invalid subdomain: 3-63 lowercase letters, digits and hyphens; not reserved and not a random id.");
	}

	const accounts = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("global"));
	const result = await accounts.fetch("https://accounts/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ subdomain }),
	});
	if (!result.ok) {
		return jsonError(502, "Account store unavailable");
	}
	const registered = (await result.json()) as { ok: boolean; code?: string; message?: string; token?: string; subdomain?: string };
	if (!registered.ok || !registered.token || !registered.subdomain) {
		return jsonError(registered.code === "subdomain_taken" ? 409 : 400, registered.message ?? "Registration failed");
	}
	const response: RegisterAccountResponse = { token: registered.token, subdomain: registered.subdomain };
	return Response.json(response, { status: 201 });
}

// ---------------------------------------------------------------------------
// Tunnel creation and connection

async function createTunnel(request: Request, env: Env, url: URL): Promise<Response> {
	const client = request.headers.get("cf-connecting-ip") ?? "local";
	const { success } = await env.CREATE_LIMIT.limit({ key: client });
	if (!success) {
		return jsonError(429, "Too many tunnels created. Try again in a minute.");
	}

	// Optional fixed-subdomain request: Authorization Bearer <apiToken> + body { subdomain }.
	const userToken = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
	let body: { subdomain?: unknown } | null = null;
	if (request.method === "POST" && request.headers.get("content-type")?.includes("json")) {
		try {
			body = (await request.json()) as { subdomain?: unknown };
		} catch {
			body = null;
		}
	}

	let id: string;
	if (userToken) {
		const subdomain = await resolveFixedSubdomain(env, userToken, typeof body?.subdomain === "string" ? body.subdomain : null);
		if (!subdomain) {
			return jsonError(401, "Invalid or missing account token, or subdomain not bound to this account.");
		}
		id = subdomain;
	} else {
		id = randomTunnelId();
	}

	await env.TUNNEL.getByName(id).init();
	await reportToRegistry(env, "created", id);

	const connectUrl = new URL(`${API_TUNNELS_PATH}/${id}/connect`, url);
	connectUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const response: CreateTunnelResponse = {
		id,
		url: `${url.protocol}//${id}.${env.TUNNEL_DOMAIN}`,
		connectUrl: connectUrl.toString(),
		token: await signConnectToken(env.TOKEN_SECRET, id),
	};
	return Response.json(response, { status: 201 });
}

/**
 * Resolves an account API token to its fixed subdomain. When `requested` is
 * given it must equal the account's bound subdomain; otherwise the bound one
 * is used. Returns null on any failure (bad token, no binding).
 */
async function resolveFixedSubdomain(env: Env, userToken: string, requested: string | null): Promise<string | null> {
	const accounts = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("global"));
	const result = await accounts.fetch(`https://accounts/lookup-token?token=${encodeURIComponent(userToken)}`);
	if (!result.ok) {
		return null;
	}
	const found = (await result.json()) as { accountId?: string; record?: { subdomain?: string | null } } | null;
	const subdomain = found?.record?.subdomain ?? null;
	if (!subdomain) {
		return null;
	}
	if (requested && requested !== subdomain) {
		return null;
	}
	return subdomain;
}

async function connectTunnel(request: Request, env: Env, id: string): Promise<Response> {
	if (!isTunnelId(id) && !isSubdomainLabel(id)) {
		return jsonError(404, "Tunnel not found");
	}
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return jsonError(426, "Expected a WebSocket upgrade");
	}
	const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
	if (!token || !(await verifyConnectToken(env.TOKEN_SECRET, id, token))) {
		return jsonError(401, "Invalid tunnel token");
	}
	await reportToRegistry(env, "connected", id);
	return env.TUNNEL.getByName(id).fetch(new Request(CONNECT_URL, request));
}

/**
 * Registry updates are best effort: a tunnel must survive registry failures.
 * Awaiting keeps the Worker alive without blocking on the DO response body.
 */
function reportToRegistry(env: Env, event: "created" | "connected" | "disconnected", id: string): Promise<void> {
	const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
	return registry
		.fetch(`https://registry/${event}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		})
		.then(() => undefined)
		.catch(() => undefined);
}

function checkProtocol(request: Request): Response | null {
	if (request.headers.get(PROTOCOL_HEADER) === String(PROTOCOL_VERSION)) {
		return null;
	}
	return jsonError(426, "This hostc version is not supported by the server. Run `npx hostc@latest` to upgrade.");
}

function randomTunnelId(): string {
	// The alphabet has 32 characters, so masking a random byte has no bias.
	const bytes = crypto.getRandomValues(new Uint8Array(TUNNEL_ID_LENGTH));
	return Array.from(bytes, (byte) => TUNNEL_ID_ALPHABET[byte & 31]).join("");
}

function jsonError(status: number, error: string): Response {
	return Response.json({ error }, { status });
}
