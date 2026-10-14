import { fireEvent, screen, within } from "@testing-library/react";
import { expect } from "vitest";

/**
 * CanvasSelect（按钮 + portal 菜单）在单测里的等价交互：点开下拉、点选目标选项。
 * 取代原生 select 时代的 fireEvent.change(combobox, { target: { value } })。
 *
 * 选项查询限定在本次打开的 listbox 里：页面上可能同时存在带同名选项的
 * 原生 select（例如品牌图文设计区），全文档查询会产生歧义。
 * fireEvent.click 不派发 mousedown，组件的「点击外部关闭」监听收不到；
 * 先对 body 派发一次 mousedown，模拟真实浏览器里打开下一个下拉时上一个
 * 菜单自动关闭。
 */
export function selectCanvasOption(
  comboboxName: string | RegExp,
  optionName: string | RegExp,
): void {
  fireEvent.mouseDown(document.body);
  fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  const listbox = screen.getByRole("listbox", { name: comboboxName });
  fireEvent.click(within(listbox).getByRole("option", { name: optionName }));
}

/** 断言 CanvasSelect 当前显示的值（按钮文案），替代 toHaveValue。 */
export function expectCanvasValue(comboboxName: string | RegExp, label: string): void {
  expect(screen.getByRole("combobox", { name: comboboxName })).toHaveTextContent(label);
}
