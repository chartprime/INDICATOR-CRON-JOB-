/**
 * The validation harness: what the validation specialist runs against every
 * indicator, as `PM/cycle1/validation-protocol.md` describes. Import from here
 * in an indicator's own `tests/` or in a validation spec.
 */
export * from "./fixtures";
export * from "./liveDrive";
export * from "./truncation";
export * from "./liveEquivalence";
export * from "./markerBudget";
export * from "./syntheticTape";
export * from "./fakeL2";
export * from "./perfProbe";
export * from "./sizeSplitReference";
