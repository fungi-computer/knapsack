import { readInputSchema } from "@fungi.computer/knapsack";

const request = readInputSchema.parse({
  path: "notes.md",
  offset: 0,
  limit: 4,
});
console.log(request); // { path: "notes.md", offset: 0, limit: 4 }
console.log(readInputSchema.safeParse({ path: "notes.md", limit: 1 }).success); // false: limit too small
