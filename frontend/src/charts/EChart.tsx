import * as echarts from "echarts/core";
import { BarChart, CustomChart, LineChart, ScatterChart } from "echarts/charts";
import { AriaComponent, DataZoomComponent, GridComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, ToolboxComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

echarts.use([BarChart, CustomChart, LineChart, ScatterChart, AriaComponent, DataZoomComponent,
  GridComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, ToolboxComponent, TooltipComponent, VisualMapComponent,
  LabelLayout, CanvasRenderer]);

export type EChartsType = echarts.ECharts;

/** Thin ECharts host: sizes to its container, re-renders on option change, exposes the
 * instance for readouts. Charts are canvas; a text summary sits next to each one. */
export function EChart({ option, height = 220, onReady, label }: {
  option: Record<string, unknown>; height?: number; onReady?: (c: EChartsType) => void; label: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
    if (chart.current && onReady) onReady(chart.current);
  }, [option, onReady]);
  return <div ref={el} className="echart" style={{ height }} role="img" aria-label={label} />;
}
