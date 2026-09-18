// A rounded pudding cup whose contents rise with completed file work.
let nextCupId = 0;

export function puddingProgress(label: string): {
  element: SVGSVGElement;
  update: (done: number, total: number, text: string) => void;
} {
  const svg = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string>,
    ...children: SVGElement[]
  ): SVGElementTagNameMap[K] => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    element.append(...children);
    return element;
  };
  const clipId = `pudding-progress-clip-${++nextCupId}`;
  const outline = "M20 43 33 98Q35 107 46 110Q60 114 74 110Q85 107 87 98L100 43";
  const liquid = svg(
    "g",
    { class: "pudding-progress-liquid", style: "transform: translateY(118px)" },
    svg("path", {
      d: "M0 4Q60-9 120 4V130H0Z",
      fill: "currentColor",
    }),
  );
  const element = svg(
    "svg",
    {
      class: "pudding-progress",
      viewBox: "0 0 120 124",
      role: "progressbar",
      "aria-label": label,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": "0",
      focusable: "false",
    },
    svg("defs", {}, svg("clipPath", { id: clipId }, svg("path", { d: `${outline}Z` }))),
    svg("g", { "clip-path": `url(#${clipId})` }, liquid),
    svg("path", {
      class: "pudding-progress-outline",
      d: outline,
    }),
    svg("path", {
      class: "pudding-progress-rim",
      d: "M60 15Q57 15 53 16L16 30Q11 32 10 35Q7 40 17 44L56 55Q60 56 64 55L103 44Q113 40 110 35Q109 32 104 30L67 16Q63 15 60 15Z",
    }),
  );
  return {
    element,
    update: (done, total, text) => {
      const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
      liquid.style.transform = `translateY(${118 - fraction * 82}px)`;
      element.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      element.setAttribute("aria-valuetext", text);
    },
  };
}
