import { describe, expect, it } from "vitest";
import { buildInputOrderByEdge } from "./connectionIndex";

describe("canvas connection indexes", () => {
  it("indexes normalized connection order by edge id", () => {
    const orderByEdge = buildInputOrderByEdge(
      new Map([["gen", [{ edgeId: "asset-b->gen" }, { edgeId: "asset-a->gen" }]]]),
      new Map([["composer", [{ edgeId: "gen->output" }]]]),
    );

    expect(orderByEdge).toEqual(
      new Map([
        ["asset-b->gen", 1],
        ["asset-a->gen", 2],
        ["gen->output", 1],
      ]),
    );
  });
});
