import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import "./SearchableMultiSelect.css";

interface SearchableMultiSelectOption {
  readonly value: string;
  readonly label: string;
}

interface SearchableMultiSelectProps {
  readonly options: readonly SearchableMultiSelectOption[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly placeholder?: string;
  readonly searchPlaceholder?: string;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

/**
 * 可搜索的多选下拉组件。
 * - 已选项以 chip 形式展示，可单独移除
 * - 下拉列表支持关键词过滤
 * - 已保存的选择不会被外部 options 变化覆盖
 * - 键盘可用：↑↓ 在选项间移动、Enter 选中、Esc 关闭（焦点始终留在搜索框）
 */
export function SearchableMultiSelect({
  options,
  value,
  onChange,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  disabled = false,
  ariaLabel,
}: SearchableMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  const selectedSet = useMemo(() => new Set(value), [value]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
        setActiveIndex(0);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // 打开时聚焦搜索框；关闭时把焦点还给展开按钮，键盘用户才不丢位置。
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  // 过滤结果变化后，高亮项不能停在越界位置。
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filteredOptions.length - 1)));
  }, [filteredOptions.length]);

  /*
   * 参与渲染的高亮下标必须是**派生值**，不能直接用 activeIndex：
   * 过滤结果从 10 条缩到 2 条时，activeIndex 此刻还是 9（要等 effect 跑完才收敛），
   * 于是这一帧的 aria-activedescendant 指向 -option-9 —— DOM 里并不存在这个 id，
   * 读屏会报「找不到当前项」。
   */
  const safeActiveIndex =
    filteredOptions.length > 0 ? Math.min(activeIndex, filteredOptions.length - 1) : 0;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    toggleRef.current?.focus();
  }, []);

  const toggleOption = (optionValue: string) => {
    if (selectedSet.has(optionValue)) {
      onChange(value.filter((v) => v !== optionValue));
    } else {
      onChange([...value, optionValue]);
    }
  };

  const toggleOpen = () => {
    if (disabled) return;
    if (open) {
      close();
      return;
    }
    setActiveIndex(0);
    setOpen(true);
  };

  const removeSelected = (optionValue: string, event: React.MouseEvent) => {
    event.stopPropagation();
    onChange(value.filter((v) => v !== optionValue));
  };

  /**
   * 键盘操作：↑↓ 移动高亮、Enter 选中当前项、Esc 关闭。
   *
   * 焦点始终留在搜索框上（listbox 用 aria-activedescendant 报告高亮项），
   * 所以纯键盘用户也能选到任何一项——这是 WCAG 2.1.1 的硬性要求。
   */
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      setActiveIndex((current) => (current + 1) % filteredOptions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      setActiveIndex((current) => (current - 1 + filteredOptions.length) % filteredOptions.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, filteredOptions.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // 用派生下标：过滤结果刚变短时 activeIndex 可能还指向越界项。
      const option = filteredOptions[safeActiveIndex];
      if (option != null) toggleOption(option.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  /*
   * 已选项要按「值」渲染，不能按 label 过滤后再按下标取回值：
   * label 为空串的选项会被 filter(Boolean) 丢掉，下标就与 value 错位，
   * 点某个 chip 的 × 会删掉另一个选择。
   */
  const selectedItems = useMemo(
    () =>
      value.map((itemValue) => ({
        value: itemValue,
        label: options.find((option) => option.value === itemValue)?.label ?? itemValue,
      })),
    [options, value],
  );

  return (
    <div className={`searchable-multi-select${disabled ? " is-disabled" : ""}`} ref={containerRef}>
      <div className="searchable-multi-select__trigger">
        {/*
         * 展开控件必须是真正的 <button>，chip 上的「移除」也是 <button>。
         * 二者不能嵌套：外层若再用 role="button"，屏幕阅读器会把两个控件读成一个，
         * 键盘焦点顺序也会乱。展开按钮铺满整格，chip 移除按钮叠在它上面单独接收点击。
         */}
        <button
          ref={toggleRef}
          type="button"
          className="searchable-multi-select__toggle"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          onClick={toggleOpen}
        />
        {selectedItems.length > 0 ? (
          <span className="searchable-multi-select__chips">
            {selectedItems.map((item) => (
              <span key={item.value} className="searchable-multi-select__chip">
                {item.label}
                <button
                  type="button"
                  className="searchable-multi-select__chip-remove"
                  aria-label={`移除 ${item.label}`}
                  disabled={disabled}
                  onClick={(event) => removeSelected(item.value, event)}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        ) : (
          <span className="searchable-multi-select__placeholder">{placeholder}</span>
        )}
        <span className="searchable-multi-select__arrow" aria-hidden="true">
          ▾
        </span>
      </div>
      {open ? (
        <div className="searchable-multi-select__dropdown">
          <input
            ref={searchInputRef}
            type="text"
            className="searchable-multi-select__search"
            placeholder={searchPlaceholder}
            value={query}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              filteredOptions.length > 0 ? `${listId}-option-${safeActiveIndex}` : undefined
            }
            aria-label={ariaLabel ?? searchPlaceholder}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <ul
            className="searchable-multi-select__options"
            role="listbox"
            id={listId}
            /* listbox 需要可访问名：读屏只会念「列表框」，不知它是「拉取令牌分组」。 */
            aria-label={ariaLabel ?? searchPlaceholder}
          >
            {filteredOptions.length === 0 ? (
              /*
               * 空态不能是 listbox 的子项：listbox 的子元素只能是 option，
               * 读屏会把无 role 的 <li> 当成「一个没有名字的选项」。
               * 用 role="presentation" 把它从语义树里摘掉。
               */
              <li className="searchable-multi-select__empty" role="presentation">
                无匹配项
              </li>
            ) : (
              filteredOptions.map((option, index) => {
                const selected = selectedSet.has(option.value);
                return (
                  <li
                    key={option.value}
                    id={`${listId}-option-${index}`}
                    role="option"
                    aria-selected={selected}
                    className={`searchable-multi-select__option${selected ? " is-selected" : ""}${index === safeActiveIndex ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => toggleOption(option.value)}
                  >
                    <span className="searchable-multi-select__checkbox">{selected ? "✓" : ""}</span>
                    <span>{option.label}</span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
