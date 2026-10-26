const { readPositiveInt, collectorCapacityLimits } = require("../../src/platform/runtime-limits");

describe("runtime-limits", () => {
  const keys = ["TT_MAX_DB_BYTES", "TT_MIN_FREE_DISK_BYTES", "RL_TEST"];
  const saved = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("readPositiveInt", () => {
    test("unset or empty returns undefined", () => {
      expect(readPositiveInt("RL_TEST")).toBeUndefined();
      process.env.RL_TEST = "";
      expect(readPositiveInt("RL_TEST")).toBeUndefined();
    });

    test("a plain positive integer is parsed", () => {
      process.env.RL_TEST = "68719476736";
      expect(readPositiveInt("RL_TEST")).toBe(68719476736);
    });

    test.each(["0", "-1", "010", "1e9", "abc", " 5", "5.0", "+5"])(
      "rejects %j",
      (value) => {
        process.env.RL_TEST = value;
        expect(() => readPositiveInt("RL_TEST")).toThrow(/positive integer of bytes/);
      },
    );

    test("rejects a value past the safe integer range", () => {
      process.env.RL_TEST = "9007199254740993";
      expect(() => readPositiveInt("RL_TEST")).toThrow(/safe integer range/);
    });
  });

  describe("collectorCapacityLimits", () => {
    test("both env unset returns an empty object", () => {
      expect(collectorCapacityLimits()).toEqual({});
    });

    test("only the set vars appear, mapped to the guard's option names", () => {
      process.env.TT_MAX_DB_BYTES = "100";
      expect(collectorCapacityLimits()).toEqual({ maxDbBytes: 100 });
      process.env.TT_MIN_FREE_DISK_BYTES = "200";
      expect(collectorCapacityLimits()).toEqual({ maxDbBytes: 100, minFreeDiskBytes: 200 });
    });

    test("an invalid value propagates the throw", () => {
      process.env.TT_MAX_DB_BYTES = "-5";
      expect(() => collectorCapacityLimits()).toThrow(/TT_MAX_DB_BYTES/);
    });
  });
});
