import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

/**
 * A label, one control and one message cell. The message is the hint until
 * there is an error, then the error replaces it in the same place, and the
 * control references it (`aria-describedby`) and turns invalid. Spread the
 * props the render function receives onto the control.
 *
 *   <Field label="Server name" hint="1 to 80 characters." error={error}>
 *     {(control) => <Input {...control} value={name} onChange={...} />}
 *   </Field>
 *
 * To nudge the field when a submit is refused, call `reject(inputElement)`.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error || hint;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-support font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-describedby": message ? messageId : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {message ? (
        <p
          id={messageId}
          // An error is announced where the user is; a hint is read on focus.
          role={error ? "alert" : undefined}
          key={error ? "error" : "hint"}
          className={cn(
            "text-support",
            error ? "roll-in text-destructive" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
