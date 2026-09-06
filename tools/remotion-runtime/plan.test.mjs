import test from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_PLAN, TEMPLATE_IDS, validatePlan } from "./plan.mjs";

test("accepts all ten templates and explicit custom layouts", () => {
  for (const template of TEMPLATE_IDS) {
    const elements = EXAMPLE_PLAN.elements.map((item, index) => ({
      ...item,
      ...(template === "pie-chart" ? { value: index } : {}),
      ...(template === "custom"
        ? {
            x: (index % 2) * 320 + 20,
            y: Math.floor(index / 2) * 180 + 160,
            width: 280,
            height: 140,
          }
        : {}),
    }));
    assert.equal(validatePlan({ ...EXAMPLE_PLAN, template, elements }).template, template);
  }
});
test("rejects executable fields and external resource properties", () => {
  for (const key of ["code", "tsx", "url", "style", "__proto__"]) {
    assert.throws(() => validatePlan({ ...EXAMPLE_PLAN, [key]: "malicious" }), /不支持的字段/);
    assert.throws(
      () =>
        validatePlan({
          ...EXAMPLE_PLAN,
          elements: [{ ...EXAMPLE_PLAN.elements[0], [key]: "malicious" }],
        }),
      /不支持的字段/,
    );
  }
});
test("requires a readable 60 frame final hold after every entry", () => {
  assert.throws(() => validatePlan({ ...EXAMPLE_PLAN, durationInFrames: 90 }), /入场时间过长/);
  assert.throws(() => validatePlan({ ...EXAMPLE_PLAN, holdFrames: 59 }), /holdFrames/);
  assert.equal(validatePlan({ ...EXAMPLE_PLAN, durationInFrames: 135 }).durationInFrames, 135);
});
test("rejects missing, negative, infinite, and overflowing pie data", () => {
  const pie = { ...EXAMPLE_PLAN, template: "pie-chart" };
  for (const value of [undefined, -1, Infinity, 0, 1e308]) {
    assert.throws(() =>
      validatePlan({ ...pie, elements: pie.elements.map((item) => ({ ...item, value })) }),
    );
  }
});
test("rejects missing references and duplicate identities", () => {
  assert.throws(
    () => validatePlan({ ...EXAMPLE_PLAN, connections: [{ from: "idea", to: "missing" }] }),
    /已存在元素/,
  );
  assert.throws(
    () =>
      validatePlan({
        ...EXAMPLE_PLAN,
        elements: [EXAMPLE_PLAN.elements[0], EXAMPLE_PLAN.elements[0]],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      validatePlan({
        ...EXAMPLE_PLAN,
        connections: [EXAMPLE_PLAN.connections[0], EXAMPLE_PLAN.connections[0]],
      }),
    /重复/,
  );
});
test("rejects incomplete and off-canvas custom coordinates", () => {
  assert.throws(() => validatePlan({ ...EXAMPLE_PLAN, template: "custom" }), /完整/);
  assert.throws(
    () =>
      validatePlan({
        ...EXAMPLE_PLAN,
        elements: [{ ...EXAMPLE_PLAN.elements[0], x: 0 }],
        connections: [],
      }),
    /完整/,
  );
  assert.throws(
    () =>
      validatePlan({
        ...EXAMPLE_PLAN,
        template: "custom",
        elements: [{ id: "a", label: "a", x: 780, y: 40, width: 80, height: 80 }],
        connections: [],
      }),
    /画布内/,
  );
});
test("text stays plain data and is never interpreted", () => {
  const text = '<script>fetch("/secret")</script>';
  assert.equal(validatePlan({ ...EXAMPLE_PLAN, title: text }).title, text);
});
test("allows empty optional text consistently with the application contract", () => {
  const parsed = validatePlan({
    ...EXAMPLE_PLAN,
    subtitle: "",
    elements: EXAMPLE_PLAN.elements.map((item) => ({ ...item, detail: "", group: "" })),
    connections: EXAMPLE_PLAN.connections.map((edge) => ({ ...edge, label: "" })),
  });
  assert.equal(parsed.subtitle, "");
  assert.equal(parsed.elements[0].detail, "");
  assert.equal(parsed.connections[0].label, "");
});
test("requires supported colors, even dimensions, bounded content and stable ids", () => {
  for (const extra of [
    { background: "url(https://example.invalid)" },
    { width: 801 },
    { title: "a".repeat(61) },
    { fps: 60 },
    { palette: [] },
    { springDamping: 8.5 },
    { staggerFrames: 61 },
  ])
    assert.throws(() => validatePlan({ ...EXAMPLE_PLAN, ...extra }));
  assert.throws(
    () =>
      validatePlan({ ...EXAMPLE_PLAN, elements: [{ id: "../file", label: "a" }], connections: [] }),
    /id/,
  );
});
