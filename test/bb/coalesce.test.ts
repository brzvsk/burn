import { describe, expect, it } from "vitest";
import { coalesce } from "../../extensions/bb/coalesce.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("coalesce", () => {
  it("joins identical calls until the pass settles, then starts a fresh one", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const keys: string[] = [];
    const read = coalesce(
      (id: string) => id,
      async (id: string) => {
        keys.push(id);
        return gates[keys.length - 1]?.promise as Promise<string>;
      },
    );
    const calls = [read("a"), read("a"), read("a")];
    expect(keys).toEqual(["a"]);
    gates[0]?.resolve("one");
    expect(await Promise.all(calls)).toEqual(["one", "one", "one"]);

    const later = read("a");
    expect(keys).toEqual(["a", "a"]);
    gates[1]?.resolve("two");
    expect(await later).toBe("two");
  });

  it("keeps different keys apart and preserves each result", async () => {
    const read = coalesce(
      (ids: string[]) => JSON.stringify(ids),
      async (ids: string[]) => ids.join(","),
    );
    expect(await Promise.all([read(["a", "b"]), read(["b", "a"]), read(["a", "b"])])).toEqual(["a,b", "b,a", "a,b"]);
  });

  it("starts a new pass after invalidate, and the old pass settling does not clear it", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let passes = 0;
    const read = coalesce(
      () => "all",
      async () => {
        const pass = passes++ === 0 ? first : second;
        return pass.promise;
      },
    );
    const before = read(undefined);
    read.invalidate();
    const after = read(undefined);
    expect(passes).toBe(2);
    first.resolve("before");
    expect(await before).toBe("before");
    // The invalidated pass settling must not remove the pass that replaced it.
    expect(read(undefined)).toBe(after);
    second.resolve("after");
    expect(await after).toBe("after");
    expect(await read(undefined)).toBe("after");
  });

  it("forgets a rejected pass so the next call retries", async () => {
    let attempts = 0;
    const read = coalesce(
      () => "one",
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("nope");
        return "ok";
      },
    );
    await expect(read(undefined)).rejects.toThrow("nope");
    expect(await read(undefined)).toBe("ok");
    expect(attempts).toBe(2);
  });
});
