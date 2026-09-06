import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type InputHTMLAttributes,
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

export function ImeTextarea({
  value,
  onValueChange,
  ...props
}: TextFieldProps<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  const input = useImeTextField<HTMLTextAreaElement>(value, onValueChange);
  return <textarea {...props} {...input} />;
}

export function ImeInput({
  value,
  onValueChange,
  ...props
}: TextFieldProps<Omit<InputHTMLAttributes<HTMLInputElement>, "type">> & {
  readonly type?: "text" | "search" | "tel" | "url" | "password";
}) {
  const input = useImeTextField<HTMLInputElement>(value, onValueChange);
  return <input {...props} {...input} />;
}
