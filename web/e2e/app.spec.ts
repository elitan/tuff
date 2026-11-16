// Browser smoke tests: the app loads from the binary without errors, and unknown URLs 404.
// (Live trains need Trafikverket, so they aren't checked here.)
import { expect, test } from "@playwright/test";

test("map loads without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".brand .word")).toHaveText("Tuff");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  expect(errors).toEqual([]);
});

test("unknown URL shows the not-found page", async ({ page }) => {
  await page.goto("/this/does/not/exist");
  await expect(page.getByRole("heading", { name: "Hittades inte" })).toBeVisible();
});

test("api health", async ({ request }) => {
  expect((await request.get("/readyz")).ok()).toBe(true);
});
