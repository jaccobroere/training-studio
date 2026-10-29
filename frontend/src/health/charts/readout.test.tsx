import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Readout } from "./parts";

describe("Readout", () => {
  it("puts the unit inline behind the value and the note on its own line below", () => {
    const html = renderToStaticMarkup(<Readout items={[["Best", "17.3", "km/h", "lap 28"]]} />);
    expect(html).toContain('17.3<small class="unit">km/h</small><small class="note">lap 28</small>');
  });
  it("renders a plain value when there is neither a unit nor a note", () => {
    const html = renderToStaticMarkup(<Readout items={[["Laps", "42"]]} />);
    expect(html).toContain("<dd>42</dd>");
  });
});
