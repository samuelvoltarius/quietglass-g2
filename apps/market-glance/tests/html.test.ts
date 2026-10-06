import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/ui/html";

describe("escapeHtml", () => {
  it("regression: a market title cannot inject markup into the phone page", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
  it("keeps an endpoint with quotes inside its attribute", () => {
    expect(escapeHtml("http://h/\"x'&")).toBe("http://h/&quot;x&#39;&amp;");
  });
  it("leaves plain text alone", () => expect(escapeHtml("Rain · YES 65c")).toBe("Rain · YES 65c"));
});
