import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type InputHTMLAttributes,
  type Ref,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";

type TextElement = HTMLInputElement | HTMLTextAreaElement;

type TextFieldProps<Attributes> = Omit<
  Attributes,
  "value" | "defaultValue" | "onChange" | "onCompositionStart" | "onCompositionEnd"
> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

/** 调用方 CSS 未声明 max-height 时的自适应兜底上限：够长提示词一屏可读，卡片又不至于无限撑高。 */
const AUTO_RESIZE_FALLBACK_MAX = 384;

function useImeTextField<Element extends TextElement>(
  value: string,
  onValueChange: (value: string) => void,
) {
  const ref = useRef<Element>(null);
  const composingRef = useRef(false);
  const publishedValueRef = useRef(value);
  const [initialValue] = useState(value);

  useLayoutEffect(() => {
    publishedValueRef.current = value;
    const element = ref.current;
    if (!element || composingRef.current || element.value === value) return;

    const focused = element.ownerDocument.activeElement === element;
    const { selectionStart, selectionEnd, selectionDirection } = element;
    element.value = value;
    if (focused && selectionStart !== null && selectionEnd !== null) {
      element.setSelectionRange(
        Math.min(selectionStart, value.length),
        Math.min(selectionEnd, value.length),
        selectionDirection ?? undefined,
      );
    }
  }, [value]);

  const publish = (nextValue: string) => {
    if (nextValue === publishedValueRef.current) return;
    publishedValueRef.current = nextValue;
    onValueChange(nextValue);
  };

  return {
    ref,
    // Canvas updates can reach React Flow after the input event. Let the browser
    // own preedit text so a stale controlled value cannot end the IME session.
    defaultValue: initialValue,
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: (event: CompositionEvent<Element>) => {
      composingRef.current = false;
      publish(event.currentTarget.value);
    },
    onChange: (event: ChangeEvent<Element>) => {
      if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
      publish(event.currentTarget.value);
    },
  };
}

/**
 * 让 textarea 高度跟随内容：输入即长高，删除即收回，超出上限才内部滚动。
 *
 * 为什么不用 CSS `field-sizing: content`：Tauri 在 Windows 走 WebView2、在 macOS 走
 * WKWebView，两端内核版本参差，滚动量量测（scrollHeight）是唯一跨端一致的做法。
 * 上限取调用方 CSS 的 max-height（没有就落到兜底值）；`rows` 的语义保留为空态高度
 * ——先归零 height 再量，rows 驱动的内在高度自然成为下限。
 * ResizeObserver 兜住「宽度变化导致换行数变化」的重排；value 之外还挂 onInput，
 * 让输入法组合中的临时行也实时撑高，而不是等提交后才跳一下。
 */
function useTextareaAutoResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
  value: string,
) {
  const resizeRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const resize = () => {
      const style = getComputedStyle(element);
      // 全局样式是 border-box：高度里要补上边框，否则每行差出 1px。
      const borders =
        (Number.parseFloat(style.borderTopWidth) || 0) +
        (Number.parseFloat(style.borderBottomWidth) || 0);
      const declaredMax =
        style.maxHeight === "none" ? AUTO_RESIZE_FALLBACK_MAX : Number.parseFloat(style.maxHeight);
      const max = Number.isFinite(declaredMax) ? declaredMax : AUTO_RESIZE_FALLBACK_MAX;
      element.style.height = "auto";
      const needed = element.scrollHeight + borders;
      const height = Math.min(needed, max);
      element.style.height = `${height}px`;
      element.style.overflowY = needed > height ? "auto" : "hidden";
    };
    resizeRef.current = resize;
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      resizeRef.current = () => {};
      observer.disconnect();
    };
  }, [enabled, ref]);
  useLayoutEffect(() => {
    resizeRef.current();
  }, [value]);
  return () => resizeRef.current();
}

/** React 19 里 ref 是普通 prop；内部 hook 的 ref 与调用方的 ref 都要接到同一个元素上。 */
function mergeRefs<T extends HTMLElement>(
  internal: RefObject<T | null>,
  incoming: Ref<T> | undefined,
): (element: T | null) => void {
  return (element) => {
    internal.current = element;
    if (typeof incoming === "function") incoming(element);
    else if (incoming != null) incoming.current = element;
  };
}

export function ImeTextarea({
  value,
  onValueChange,
  autoResize = true,
  onInput,
  ref: incomingRef,
  ...props
}: TextFieldProps<TextareaHTMLAttributes<HTMLTextAreaElement>> & {
  /** 高度跟随内容；只读预览等需要固定高度的场景可显式关掉。 */
  readonly autoResize?: boolean;
  readonly ref?: Ref<HTMLTextAreaElement>;
}) {
  const input = useImeTextField<HTMLTextAreaElement>(value, onValueChange);
  const resize = useTextareaAutoResize(input.ref, autoResize, value);
  return (
    <textarea
      {...props}
      {...input}
      ref={mergeRefs(input.ref, incomingRef)}
      onInput={(event) => {
        onInput?.(event);
        resize();
      }}
    />
  );
}

export function ImeInput({
  value,
  onValueChange,
  ref: incomingRef,
  ...props
}: TextFieldProps<Omit<InputHTMLAttributes<HTMLInputElement>, "type">> & {
  readonly type?: "text" | "search" | "tel" | "url" | "password";
  readonly ref?: Ref<HTMLInputElement>;
}) {
  const input = useImeTextField<HTMLInputElement>(value, onValueChange);
  return <input {...props} {...input} ref={mergeRefs(input.ref, incomingRef)} />;
}
