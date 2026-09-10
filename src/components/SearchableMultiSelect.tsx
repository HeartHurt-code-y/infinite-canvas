import { useEffect, useMemo, useRef, useState } from "react";
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selectedSet = useMemo(() => new Set(value), [value]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // 打开时聚焦搜索框
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  const toggleOption = (optionValue: string) => {
    if (selectedSet.has(optionValue)) {
      onChange(value.filter((v) => v !== optionValue));
    } else {
      onChange([...value, optionValue]);
    }
  };

  const removeSelected = (optionValue: string, event: React.MouseEvent) => {
    event.stopPropagation();
    onChange(value.filter((v) => v !== optionValue));
  };

  const selectedLabels = value
    .map((v) => options.find((o) => o.value === v)?.label ?? v)
    .filter(Boolean);

  return (
    <div className="searchable-multi-select" ref={containerRef}>
      <button
        type="button"
        className="searchable-multi-select__trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => !disabled && setOpen((prev) => !prev)}
      >
        {selectedLabels.length > 0 ? (
          <span className="searchable-multi-select__chips">
            {selectedLabels.map((label, index) => (
              <span key={value[index]} className="searchable-multi-select__chip">
                {label}
                <button
                  type="button"
                  className="searchable-multi-select__chip-remove"
                  aria-label={`移除 ${label}`}
                  onClick={(event) => removeSelected(value[index]!, event)}
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
      </button>
      {open ? (
        <div className="searchable-multi-select__dropdown">
          <input
            ref={searchInputRef}
            type="text"
            className="searchable-multi-select__search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="searchable-multi-select__options" role="listbox">
            {filteredOptions.length === 0 ? (
              <li className="searchable-multi-select__empty">无匹配项</li>
            ) : (
              filteredOptions.map((option) => {
                const selected = selectedSet.has(option.value);
                return (
                  <li
                    key={option.value}
                    role="option"
                    aria-selected={selected}
                    className={`searchable-multi-select__option${selected ? " is-selected" : ""}`}
                    onClick={() => toggleOption(option.value)}
                  >
                    <span className="searchable-multi-select__checkbox">
                      {selected ? "✓" : ""}
                    </span>
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
