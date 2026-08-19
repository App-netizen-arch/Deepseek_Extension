import { describe, expect, it } from "vitest";
import { parseBdsTags } from "../src/tag-parser.js";

describe("BDS tag parser", () => {
  it("parses a tag and scalar/JSON attributes", () => {
    const input = `BDS:LOCAL_EXEC\nlanguage = \"zig\"\nargs = [\"build-exe\", \"src/main.zig\"]\ntimeout = 15\n`;
    const [tag] = parseBdsTags(input);
    expect(tag.name).toBe("LOCAL_EXEC");
    expect(tag.attributes.language).toBe("zig");
    expect(tag.attributes.args).toEqual(["build-exe", "src/main.zig"]);
    expect(tag.attributes.timeout).toBe(15);
  });

  it("does not treat prose after a tag as commands without key/value syntax", () => {
    const input = `BDS:AGENT_STATUS\nshow = true\nThis is untrusted prose\n`;
    const [tag] = parseBdsTags(input);
    expect(tag.name).toBe("AGENT_STATUS");
    expect(tag.attributes.show).toBe(true);
    expect(Object.keys(tag.attributes)).toEqual(["show"]);
  });

  it("terminates when the input contains only the final tag", () => {
    const input = `BDS:AGENT_STATUS\nshow = true\n`;
    expect(parseBdsTags(input)).toEqual([
      expect.objectContaining({
        name: "AGENT_STATUS",
        attributes: { show: true },
      }),
    ]);
  });
});
