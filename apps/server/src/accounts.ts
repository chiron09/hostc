import { DurableObject } from "cloudflare:workers";

/**
 * Account registry for fixed-subdomain users.
 *
 * Each account has one opaque API token (shown once, stored only as a salted
 * hash) and one bound subdomain. Binding is first-come, first-served and
 * permanent: the DO keeps a bidirectional index so a subdomain cannot be
 * reused after the account is deleted.
 */

export type AccountRecord = {
	/** Token hash, salted: `<salt>:<sha256(salt + token)>`. */
	tokenHash: string;
	/** The fixed subdomain, or null when none has been bound yet. */
	subdomain: string | null;
	createdAt: number;
};

const ACCOUNT_PREFIX = "account:";
const SUBDOMAIN_PREFIX = "subdomain:";
/** Prefix for the "already used" tombstone of a subdomain. */
const TOMBSTONE_PREFIX = "subdomain-gone:";

export class Accounts extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/register") {
				const body = (await request.json()) as { subdomain?: unknown; token?: unknown };
				const subdomain = typeof body.subdomain === "string" ? body.subdomain.toLowerCase() : "";
				const token = typeof body.token === "string" ? body.token : "";
				return Response.json(await this.register(subdomain, token));
			}
			if (request.method === "GET" && url.pathname === "/lookup-token") {
				const token = url.searchParams.get("token") ?? "";
				const record = await this.accountByToken(token);
				return Response.json(record);
			}
			if (request.method === "GET" && url.pathname === "/lookup-subdomain") {
				const subdomain = (url.searchParams.get("subdomain") ?? "").toLowerCase();
				const accountId = await this.accountIdBySubdomain(subdomain);
				return Response.json({ accountId });
			}
			return Response.json({ error: "Not found" }, { status: 404 });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	}

	/**
	 * Binds a fixed subdomain to a new account and returns the plaintext token
	 * (generated here) plus the subdomain. Fails with a specific code when the
	 * subdomain is taken.
	 */
	private async register(
		subdomain: string,
		_ignoredToken: string,
	): Promise<{ ok: true; accountId: string; token: string; subdomain: string } | { ok: false; code: string; message: string }> {
		const store = this.ctx.storage;
		const accountId = crypto.randomUUID();
		const token = randomToken();

		// Subdomain binding is the only contended resource; guard it with a
		// transaction so two concurrent registrations cannot both claim it.
		const claimed = await store.transaction(async (txn) => {
			const existing = (await txn.get<string>(SUBDOMAIN_PREFIX + subdomain)) ?? (await txn.get<string>(TOMBSTONE_PREFIX + subdomain));
			if (existing) {
				return false;
			}
			await txn.put(SUBDOMAIN_PREFIX + subdomain, accountId);
			return true;
		});
		if (!claimed) {
			return { ok: false, code: "subdomain_taken", message: "That subdomain is already taken." };
		}

		const record: AccountRecord = {
			tokenHash: await hashToken(token),
			subdomain,
			createdAt: Date.now(),
		};
		await store.put(ACCOUNT_PREFIX + accountId, record);

		return { ok: true, accountId, token, subdomain };
	}

	/** Resolves a token to its account record, or null. */
	async accountByToken(token: string): Promise<{ accountId: string; record: AccountRecord } | null> {
		if (!token) {
			return null;
		}
		// The token hash is salted; a lookup must still scan accounts. This is
		// acceptable: tokens are high-entropy and this DO only serves auth.
		const store = this.ctx.storage;
		const entries = await store.list<AccountRecord>({ prefix: ACCOUNT_PREFIX, limit: 1000 });
		for (const [key, record] of entries) {
			if (await tokenMatches(token, record.tokenHash)) {
				return { accountId: key.slice(ACCOUNT_PREFIX.length), record };
			}
		}
		return null;
	}

	async accountIdBySubdomain(subdomain: string): Promise<string | null> {
		if (!subdomain) {
			return null;
		}
		const id = await this.ctx.storage.get<string>(SUBDOMAIN_PREFIX + subdomain);
		if (id) {
			return id;
		}
		const tombstone = await this.ctx.storage.get<string>(TOMBSTONE_PREFIX + subdomain);
		// A tombstone means "used before"; treat as taken so it can never be re-issued.
		return tombstone ? "taken" : null;
	}
}

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return toBase64Url(bytes);
}

async function hashToken(token: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const saltHex = toHex(salt);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${saltHex}:${token}`));
	return `${saltHex}:${toHex(new Uint8Array(digest))}`;
}

async function tokenMatches(token: string, stored: string): Promise<boolean> {
	const [saltHex, expected] = stored.split(":");
	if (!saltHex || !expected) {
		return false;
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${saltHex}:${token}`));
	const actual = toHex(new Uint8Array(digest));
	// Constant-time comparison to avoid timing side channels on the hash.
	const a = new TextEncoder().encode(actual).buffer as ArrayBuffer;
	const b = new TextEncoder().encode(expected).buffer as ArrayBuffer;
	return crypto.subtle.timingSafeEqual(a, b);
}

function toBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
