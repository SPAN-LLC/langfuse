import { type singleFilter } from "@/src/server/api/interfaces/filters";
import { type z } from "zod";

// to be sent to the server
export type FilterCondition = z.infer<typeof singleFilter>;
export type UIFilterCondition = FilterCondition & { urlName: string };
export type FilterState = FilterCondition[];

// to be used in the client during editing
type MakeOptional<T> = {
  [K in keyof T]?: T[K];
};
// if key is value, add string as value
type AllowStringAsValue<T> = {
  [K in keyof T]: K extends "value" ? string | T[K] : T[K];
};

export type WipFilterCondition = AllowStringAsValue<
  MakeOptional<FilterCondition>
>;
export type WipFilterState = WipFilterCondition[];

export type FilterOption = {
  value: string;
  count?: number;
};

export type TableName =
  | "traces"
  | "generations"
  | "sessions"
  | "scores"
  | "dashboard";
