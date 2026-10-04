import * as React from "react";

import { cn } from "@/lib/utils";

// The scroll region tracks its own position (global.css styles it from the
// outside): data-scrolled once scrolled past 2px casts the pinned first
// column's edge shadow, and --fade-end fades the right edge while more columns
// wait. With a `label` it is a focusable, named region so the arrow keys scroll.
function Table({
  className,
  label,
  ...props
}: React.ComponentProps<"table"> & { label?: string }) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cue = () => {
      el.toggleAttribute("data-scrolled", el.scrollLeft > 2);
      const more = el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
      el.style.setProperty("--fade-end", more ? "2rem" : "0px");
    };
    cue();
    el.addEventListener("scroll", cue, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(cue);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", cue);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
      {...(label ? { tabIndex: 0, role: "region", "aria-label": label } : null)}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={className}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={className}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={className}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-9 px-3 text-left align-middle text-label whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

/** The first cell of a body row: names the row for every cell after it. */
function TableRowHeader({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-row-header"
      scope="row"
      className={cn(
        "px-3 py-3 text-left align-middle font-semibold whitespace-nowrap text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRowHeader,
  TableRow,
  TableCell,
};
