import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("date controls, empty ranges, and both themes render cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const filters = page.locator("#date-filters");
  const toggle = page.locator(".refreshToggle");
  await expect(filters).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(filters).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const period = page.getByRole("combobox", { name: "Period", exact: true });
  await expect(period.locator("option")).toHaveText(["1 day", "3 days", "7 days", "31 days", "3 months", "6 months", "All time"]);
  await period.selectOption("1");
  await expect(page.locator(".timelineSingleDay")).toBeVisible();
  const data = JSON.parse(readFileSync("data/daily-burn.json", "utf8"));
  const lastDay = data[data.length - 1];
  await expect(page.locator(".modelShareBar")).toBeVisible();
  const before = await page.locator(".modelShareHeading > span").innerText();
  expect(lastDay.codex_tokens + lastDay.claude_code_tokens).toBeGreaterThan(0);
  await period.selectOption("all");
  await expect(page.locator(".modelShareHeading > span")).not.toHaveText(before);
  const widths = await page.locator(".modelShareSegment").evaluateAll((elements) => elements.reduce((sum, el) => sum + parseFloat((el as HTMLElement).style.width), 0));
  expect(widths).toBeCloseTo(100, 4);
  await expect(page.getByRole("heading", { name: "Explore recorded usage" })).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("2099-01-01");
  await expect(page.getByText("No recorded days in this date range.")).toBeVisible();
  await page.getByRole("button", { name: "Reset dates" }).click();
  await page.getByRole("button", { name: /ticker/i }).click();
  await expect(page.locator("main")).toHaveAttribute("data-theme", "ticker");
  await page.locator(".refreshToggle").click();
  await expect(filters).toBeHidden();
  await page.locator(".refreshToggle").focus();
  await page.locator(".refreshToggle").press("Enter");
  await expect(filters).toBeVisible();
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("timeline supports keyboard inspection", async ({ page }) => {
  await page.goto("/");
  const chart = page.getByRole("slider");
  await chart.focus();
  await chart.press("Home");
  await expect(chart).toHaveAttribute("aria-valuenow", "0");
  await chart.press("ArrowRight");
  await expect(chart).toHaveAttribute("aria-valuenow", "1");
  await expect(page.locator(".timelineTooltip")).toBeVisible();
  await chart.press("End");
  expect(await chart.getAttribute("aria-valuenow")).toBe(await chart.getAttribute("aria-valuemax"));
});

test("explorer filters and sanitized labels persist and export", async ({ page }) => {
  await page.goto("/");
  const explorer = page.locator(".usageExplorer");
  await explorer.getByRole("combobox", { name: "Tool", exact: true }).selectOption("codex");
  await explorer.getByRole("combobox", { name: "Model", exact: true }).selectOption("gpt-6-astra");
  const day = explorer.locator("details").first();
  await day.locator("summary").click();
  const category = day.getByRole("combobox");
  await category.selectOption("review");
  await expect(day.locator("summary")).toContainText("review");
  const download = page.waitForEvent("download");
  await explorer.getByRole("button", { name: "Export labels" }).click();
  expect((await download).suggestedFilename()).toBe("driver-labels.json");
  await page.reload();
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("token-burn-driver-labels-v1") || "{}")))).toContain("review");
});

test("stale collection does not claim live or invent today's readings", async ({ page }) => {
  const meta = JSON.parse(readFileSync("data/meta.json", "utf8"));
  await page.clock.install({ time: new Date(Date.parse(meta.collected_at) + 24 * 60 * 60_000) });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Refresh overdue", exact: true })).toBeVisible();
  await expect(page.locator(".prRingPct").first()).toHaveText("—");
  await expect(page.locator(".prRingPct").last()).toHaveText("—");
});
