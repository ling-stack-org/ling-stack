import { forwardRef, type HTMLAttributes, type TableHTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export const TableContainer = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TableContainer({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={mergeClassNames("ling-ui-table-container", className)} />;
});

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(function Table({ className, ...props }, ref) {
  return <table {...props} ref={ref} className={mergeClassNames("ling-ui-table", className)} />;
});

export const TableHead = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(function TableHead({ className, ...props }, ref) {
  return <thead {...props} ref={ref} className={mergeClassNames("ling-ui-table-head", className)} />;
});

export const TableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(function TableBody({ className, ...props }, ref) {
  return <tbody {...props} ref={ref} className={mergeClassNames("ling-ui-table-body", className)} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(function TableRow({ className, ...props }, ref) {
  return <tr {...props} ref={ref} className={mergeClassNames("ling-ui-table-row", className)} />;
});

export const TableHeaderCell = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(function TableHeaderCell({ className, scope = "col", ...props }, ref) {
  return <th {...props} ref={ref} className={mergeClassNames("ling-ui-table-header-cell", className)} scope={scope} />;
});

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(function TableCell({ className, ...props }, ref) {
  return <td {...props} ref={ref} className={mergeClassNames("ling-ui-table-cell", className)} />;
});
