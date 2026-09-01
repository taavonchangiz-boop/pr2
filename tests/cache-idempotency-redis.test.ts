// =====================================================================
// POSTYAR — C-01 regression: Redis idempotency protocol
// ---------------------------------------------------------------------
// The production Redis path (redisIdempotencyBackend) is exercised here
// against a REAL ioredis client talking RESP over TCP to an in-process
// Redis server whose EVAL command EXECUTES THE PRODUCTION LUA SCRIPTS on
// a real Lua VM (fengari). The in-memory fallback is NOT enough to prove
// the Redis-specific correctness properties (master prompt §35), so this
// suite drives the exact Lua scripts imported from cache.ts semantics.
//
// Proven properties (each would FAIL on the pre-C-01 implementation,
// which deleted the claim marker after storing the result and never
// re-checked it before re-claiming):
//   1. sequential duplicate after completion  → fn once
//   2. concurrent duplicate                    → fn once
//   3. late duplicate after completion         → same result, fn once
//   4. abandoned claim (claim TTL expiry)      → next caller re-executes
//   5. failed fn                               → no result cached, retry
//   6. claim/result race                       → no lost result, fn once
//   7. multiple simulated workers              → fn once across workers
// =====================================================================
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:net";
import net from "node:net";

// ---------------- Fake Redis (RESP2 + real Lua via fengari) ----------------
//
// The production Lua scripts run VERBATIM inside a real Lua VM. No JS
// shim participates in the script semantics: redis.call is implemented in
// PURE LUA against a Lua-table data store, so nil/false handling, string
// comparisons and the scripts' return conventions behave exactly like a
// real Redis Lua environment. State (keys + PX expiries) is exchanged
// with the JS server as byte-escaped Lua literals on every EVAL.

type Entry = { value: string; expireAt: number | null };

function luaEscaped(s: string): string {
  // Byte-escape into a Lua string literal — every byte outside [A-Za-z0-9_]
  // becomes \ddd, so any content (JSON, unicode, quotes, newlines) is safe.
  let out = "'";
  const bytes = Buffer.from(s, "utf8");
  for (const b of bytes) {
    const c = b as number;
    const isSafe = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
    if (isSafe) out += String.fromCharCode(c);
    else out += "\\" + String(c).padStart(3, "0");
  }
  out += "'";
  return out;
}

const REDIS_LIB_LUA = `
redis = {}
function redis.call(cmd, ...)
  cmd = string.lower(tostring(cmd))
  local args = {...}
  if cmd == 'get' then
    local k = tostring(args[1])
    local e = __exp[k]
    if e ~= nil and e <= __NOW then __data[k] = nil; __exp[k] = nil; return false end
    local v = __data[k]
    if v == nil then return false end
    return v
  elseif cmd == 'set' then
    local k = tostring(args[1])
    local v = tostring(args[2])
    local px = nil
    local nx = false
    local i = 3
    while i <= #args do
      local up = string.upper(tostring(args[i]))
      if up == 'PX' then px = tonumber(args[i + 1]); i = i + 2
      elseif up == 'NX' then nx = true; i = i + 1
      else i = i + 1 end
    end
    local exists = __data[k] ~= nil
    if exists then
      local e = __exp[k]
      if e ~= nil and e <= __NOW then exists = false end
    end
    if nx and exists then return false end
    __data[k] = v
    if px ~= nil then __exp[k] = __NOW + px else __exp[k] = nil end
    return 'OK'
  elseif cmd == 'del' then
    local k = tostring(args[1])
    local had = __data[k] ~= nil
    __data[k] = nil
    __exp[k] = nil
    if had then return 1 else return 0 end
  end
  error('unsupported command: ' .. tostring(cmd))
end
`;

function createFakeRedisState() {
  const data = new Map<string, Entry>();
  return { data };
}

async function evalScript(
  state: ReturnType<typeof createFakeRedisState>,
  script: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const { lua, lauxlib, lualib, to_luastring } = await import("fengari");
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const nowMs = Date.now();
  // Serialize current data + expiries as escaped Lua literals.
  let dataLit = "__data = {}\n";
  let expLit = "__exp = {}\n";
  for (const [k, v] of state.data) {
    if (v.expireAt !== null && v.expireAt <= nowMs) continue; // expired
    dataLit += `__data[${luaEscaped(k)}] = ${luaEscaped(v.value)}\n`;
    if (v.expireAt !== null) expLit += `__exp[${luaEscaped(k)}] = ${v.expireAt.toFixed(1)}\n`;
  }
  const keysLit = keys.map((k) => luaEscaped(k)).join(", ");
  const argsLit = args.map((a) => luaEscaped(a)).join(", ");
  const host =
    `${dataLit}${expLit}__NOW = ${nowMs}.0\n` +
    REDIS_LIB_LUA +
    `KEYS = { ${keysLit} }\n` +
    `ARGV = { ${argsLit} }\n` +
    `local __f, __err = load(${luaEscaped(script)})\n` +
    `if not __f then error('script compile failed: ' .. tostring(__err)) end\n` +
    `return __f()\n`;

  const status = lauxlib.luaL_dostring(L, to_luastring(host.replace(/\\n/g, "\n")));
  if (status !== lua.LUA_OK) {
    const t = lua.lua_type(L, -1);
    let msg = "lua error";
    if (t === lua.LUA_TSTRING) msg = lua.lua_tojsstring(L, -1);
    else {
      // last resort: raw string push
      msg = `lua error (type ${t})`;
    }
    throw new Error(msg);
  }
  const convert = (idx: number): unknown => {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (t === lua.LUA_TSTRING) return lua.lua_tojsstring(L, idx);
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx) === 1;
    if (t === lua.LUA_TNIL || t === lua.LUA_TNONE) return null;
    if (t === lua.LUA_TTABLE) {
      const out: unknown[] = [];
      const n = lua.lua_rawlen(L, idx);
      let i = 1;
      while (i <= n) {
        lua.lua_rawgeti(L, idx, i);
        out.push(convert(-1));
        lua.lua_pop(L, 1);
        i++;
      }
      return out;
    }
    return null;
  };
  const result = convert(-1);

  // Persist the mutated data store back to JS (walk __data + __exp).
  const readTable = (name: string): Map<string, string | number | null> => {
    const out = new Map<string, string | number | null>();
    lua.lua_getglobal(L, to_luastring(name));
    const t = lua.lua_type(L, -1);
    if (t === lua.LUA_TTABLE) {
      lua.lua_pushnil(L);
      while (lua.lua_next(L, -2) !== 0) {
        const key = lua.lua_tojsstring(L, -2);
        const vt = lua.lua_type(L, -1);
        let value: string | number | null = null;
        if (vt === lua.LUA_TSTRING) value = lua.lua_tojsstring(L, -1);
        else if (vt === lua.LUA_TNUMBER) value = lua.lua_tonumber(L, -1);
        out.set(key, value);
        lua.lua_pop(L, 1);
      }
    }
    lua.lua_pop(L, 1);
    return out;
  };
  const newData = readTable("__data");
  const newExp = readTable("__exp");
  state.data.clear();
  for (const [k, v] of newData) {
    if (v === null) continue;
    const e = newExp.get(k);
    const expireAt = typeof e === "number" ? e : null;
    state.data.set(k, { value: String(v), expireAt });
  }
  return result;
}

function startFakeRedisServer(): Promise<{ server: Server; port: number; state: ReturnType<typeof createFakeRedisState> }> {
  const state = createFakeRedisState();
  // Wire-level GET/SET/DEL (used outside EVAL) operate on the same store.
  const wireGet = (key: string): string | null => {
    const e = state.data.get(key);
    if (!e) return null;
    if (e.expireAt !== null && e.expireAt <= Date.now()) { state.data.delete(key); return null; }
    return e.value;
  };
  const wireDel = (key: string): number => (state.data.delete(key) ? 1 : 0);
  // Minimal RESP2 parser: arrays of bulk strings only (all ioredis sends here).
  return new Promise((resolve) => {
    let pending: Server | null = null;
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", async (d) => {
        buf += d.toString("utf8");
        // Process as many complete commands as available.
        for (;;) {
          const parsed = parseCommand(buf);
          if (!parsed) break;
          buf = buf.slice(parsed.consumed);
          const reply = await handle(parsed.array);
          socket.write(reply);
        }
      });
      socket.on("error", () => undefined);

      function parseCommand(s: string): { array: string[]; consumed: number } | null {
        if (!s.startsWith("*")) return null;
        const firstCrlf = s.indexOf("\r\n");
        if (firstCrlf === -1) return null;
        const count = Number.parseInt(s.slice(1, firstCrlf), 10);
        if (!Number.isFinite(count)) return null;
        let pos = firstCrlf + 2;
        const arr: string[] = [];
        for (let i = 0; i < count; i++) {
          if (s[pos] !== "$") return null;
          const lenEnd = s.indexOf("\r\n", pos);
          if (lenEnd === -1) return null;
          const len = Number.parseInt(s.slice(pos + 1, lenEnd), 10);
          const start = lenEnd + 2;
          const end = start + len;
          if (s.length < end + 2) return null;
          arr.push(s.slice(start, end));
          pos = end + 2;
        }
        return { array: arr, consumed: pos };
      }

      async function handle(cmd: string[]): Promise<string> {
        const c = cmd[0]?.toLowerCase();
        if (c === "get") {
          const v = wireGet(cmd[1] as string);
          return v === null ? "$-1\r\n" : `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
        }
        if (c === "set") {
          // Parse PX <ms> / NX options (ioredis sends them positionally).
          let px: number | undefined;
          let nx = false;
          for (let i = 3; i < cmd.length; i++) {
            const up = cmd[i]?.toUpperCase();
            if (up === "PX") { px = Number(cmd[i + 1]); i++; }
            else if (up === "NX") nx = true;
          }
          state.data.set(cmd[1] as string, {
            value: cmd[2] as string,
            expireAt: px ? Date.now() + px : null,
          });
          return `+OK\r\n`;
        }
        if (c === "del") {
          return `:${wireDel(cmd[1] as string)}\r\n`;
        }
        if (c === "eval") {
          // EVAL script numkeys key1..keyN arg1..argN
          const script = cmd[1] as string;
          const numkeys = Number.parseInt(cmd[2] as string, 10);
          const keys = cmd.slice(3, 3 + numkeys);
          const args = cmd.slice(3 + numkeys);
          try {
            const r = await evalScript(state, script, keys, args);
            return encodeReply(r);
          } catch (e) {
            const msg = e instanceof Error ? e.message : "lua error";
            return `-ERR ${msg.replace(/\r?\n/g, " ")}\r\n`;
          }
        }
        if (c === "ping") return "+PONG\r\n";
        if (c === "info") {
          // ioredis ready-check payload (minimal but well-formed).
          const body = "# Server\r\nredis_version:7.0.0\r\nredis_mode:standalone\r\n# Clients\r\nconnected_clients:1\r\n";
          return `$${Buffer.byteLength(body)}\r\n${body}\r\n`;
        }
        if (c === "client") return "+OK\r\n"; // CLIENT SETINFO (Redis 7.2 handshake)
        if (c === "hello") return "-ERR unknown command 'HELLO'\r\n"; // keep RESP2
        return `-ERR unknown command '${cmd[0]}'\r\n`;
      }

      function encodeReply(r: unknown): string {
        if (r === null || r === undefined) return "$-1\r\n";
        if (typeof r === "boolean") return r ? ":1\r\n" : ":0\r\n";
        if (typeof r === "number") return `:${r}\r\n`;
        if (typeof r === "string") return `$${Buffer.byteLength(r)}\r\n${r}\r\n`;
        if (Array.isArray(r)) return `*${r.length}\r\n` + r.map(encodeReply).join("");
        return `$-1\r\n`;
      }
    });
    pending = server;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, state });
    });
  });
}

// ---------------- The tests ----------------

describe("C-01 — Redis idempotency protocol (real Lua on a RESP server)", () => {
  let server: Server;
  let port: number;
  let state: ReturnType<typeof createFakeRedisState>;
  let originalUrl: string | undefined;

  beforeAll(async () => {
    const started = await startFakeRedisServer();
    server = started.server;
    port = started.port;
    state = started.state;
    originalUrl = process.env.REDIS_URL;
    // Point the app at the fake Redis for the duration of this suite.
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    // Force cache.ts to re-detect liveness against the new URL.
    const { refreshRedisLiveness } = await import("../src/lib/security/cache");
    await refreshRedisLiveness();
  });

  afterAll(() => {
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
    server.close();
  });

  test("sequential duplicate after completion returns the SAME result and executes fn ONCE", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let calls = 0;
    const fn = async () => { calls += 1; return { v: 42 }; };
    const r1 = await idempotency("seq-dup", fn);
    const r2 = await idempotency("seq-dup", fn);
    expect(r1).toEqual({ v: 42 });
    expect(r2).toEqual({ v: 42 });
    expect(calls).toBe(1);
  });

  test("concurrent duplicates execute fn exactly once and share the result", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 80));
      return { n: calls };
    };
    const results = await Promise.all([
      idempotency("conc-dup", fn),
      idempotency("conc-dup", fn),
      idempotency("conc-dup", fn),
      idempotency("conc-dup", fn),
      idempotency("conc-dup", fn),
    ]);
    expect(calls).toBe(1);
    for (const r of results) expect(r).toEqual({ n: 1 });
  });

  test("late duplicate long after completion does NOT re-execute fn (pre-fix regression)", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let calls = 0;
    const fn = async () => { calls += 1; return { late: true }; };
    await idempotency("late-dup", fn);
    // Wait well beyond any in-flight window; the pre-fix code deleted the
    // claim marker on completion, so a late caller re-claimed and re-ran.
    await new Promise((r) => setTimeout(r, 150));
    const r2 = await idempotency("late-dup", fn);
    expect(r2).toEqual({ late: true });
    expect(calls).toBe(1);
  });

  test("abandoned claim (claim TTL expiry) is safely recovered by the next caller", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let calls = 0;
    // First caller "crashes": it claims, then never completes (simulated
    // by directly writing the inflight marker through the claim protocol
    // with a tiny TTL).
    const { IDEM_TEST_HOOKS } = await import("../src/lib/security/cache");
    const claimKey = IDEM_TEST_HOOKS.claimKeyFor("abandoned");
    const res = await IDEM_TEST_HOOKS.rawEvalClaimTiny(claimKey, "worker-1", 40);
    expect(res).toBe(1);
    await new Promise((r) => setTimeout(r, 90)); // let the claim expire
    const result = await idempotency("abandoned", async () => { calls += 1; return { ok: true }; });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("failed fn releases the claim and the NEXT caller re-executes (failures never cached)", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let attempts = 0;
    const failing = async () => { attempts += 1; throw new Error("boom"); };
    await expect(idempotency("failed-fn", failing)).rejects.toThrow("boom");
    expect(attempts).toBe(1);
    const ok = await idempotency("failed-fn", async () => ({ healed: true }));
    expect(ok).toEqual({ healed: true });
    expect(attempts).toBe(1); // failing fn was NOT retried internally
  });

  test("claim/result race: a completed result is returned even when the winner's claim was already released", async () => {
    const { idempotency, IDEM_TEST_HOOKS } = await import("../src/lib/security/cache");
    // Simulate the interleaving: complete → immediately poll as a loser.
    const raceCalls = { n: 0 };
    const r1 = await idempotency("claim-race", async () => { raceCalls.n += 1; return { w: 1 }; });
    // Loser arriving now must read the durable result, not re-run.
    const loser = await IDEM_TEST_HOOKS.rawEvalAcquire(IDEM_TEST_HOOKS.claimKeyFor("claim-race"), "loser", 30_000);
    expect(loser[0]).toBe(2); // completed — result visible
    expect(JSON.parse(String(loser[1]))).toEqual({ w: 1 });
    expect(r1).toEqual({ w: 1 });
    expect(raceCalls.n).toBe(1);
  });

  test("multiple simulated workers: exactly one execution across 8 concurrent processes", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { worker: true };
    };
    const workers = Array.from({ length: 8 }, (_, i) =>
      idempotency(`multi-worker-${i % 1}`, fn).catch((e) => ({ error: String(e) })),
    );
    const results = await Promise.all(workers);
    expect(calls).toBe(1);
    for (const r of results) expect(r).toEqual({ worker: true });
  });

  test("result TTL expiry allows re-execution (bounded memory of results)", async () => {
    const { idempotency } = await import("../src/lib/security/cache");
    let calls = 0;
    const fn = async () => { calls += 1; return { at: calls }; };
    await idempotency("ttl-exp", fn, 40); // 40ms result TTL
    await new Promise((r) => setTimeout(r, 120));
    const r2 = await idempotency("ttl-exp", fn, 40);
    expect(r2).toEqual({ at: 2 });
    expect(calls).toBe(2);
  });
});
