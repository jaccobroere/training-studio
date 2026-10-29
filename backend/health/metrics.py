"""The metric catalogue: one definition per number, shared by charts, tables and the
assistant's tools, so the same value means the same thing everywhere."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    unit: str
    agg: str  # how to aggregate over days: mean | sum | last | max | min
    meaning: str
    better: str | None = None  # "up" | "down" | None (no judgement)
    estimate: bool = False  # a device/vendor estimate rather than a direct measurement


METRICS: dict[str, Metric] = {m.key: m for m in [
    Metric("hrv_ms", "HRV (overnight avg)", "ms", "mean",
           "Garmin's last-night average HRV (RMSSD-based) from the sleep window.", "up"),
    Metric("hrv_weekly_ms", "HRV (7-day avg)", "ms", "mean", "Garmin's rolling 7-day HRV average.", "up"),
    Metric("rhr_bpm", "Resting heart rate", "bpm", "mean", "Garmin's daily resting heart rate.", "down"),
    Metric("sleep_h", "Sleep", "h", "mean", "Total sleep time for the night ending on this date (excl. awake).", "up"),
    Metric("sleep_score", "Sleep score", "pts", "mean", "Garmin sleep score (0–100).", "up", estimate=True),
    Metric("stress_avg", "Stress (avg)", "pts", "mean", "Garmin all-day average stress (0–100).", "down", estimate=True),
    Metric("bb_max", "Body Battery high", "pts", "mean", "Highest Body Battery value of the day.", "up", estimate=True),
    Metric("bb_min", "Body Battery low", "pts", "mean", "Lowest Body Battery value of the day.", None, estimate=True),
    Metric("bb_charged", "Body Battery charged", "pts", "mean", "Body Battery gained during the day.", None, estimate=True),
    Metric("bb_drained", "Body Battery drained", "pts", "mean", "Body Battery spent during the day.", None, estimate=True),
    Metric("steps", "Steps", "steps", "mean", "Daily step count.", None),
    Metric("weight_kg", "Weight", "kg", "last", "Body weight measurement.", None),
    Metric("body_fat_pct", "Body fat", "%", "last", "Body fat estimate from a smart scale.", None, estimate=True),
    Metric("vo2max", "VO2max (running)", "ml/kg/min", "last", "Garmin's running VO2max estimate.", "up", estimate=True),
    Metric("respiration", "Respiration (sleep)", "brpm", "mean", "Average breaths per minute during sleep.", None),
    Metric("spo2", "SpO2 (sleep)", "%", "mean", "Average pulse-ox during sleep.", None, estimate=True),
    Metric("readiness", "Training readiness", "pts", "mean", "Garmin training readiness score.", None, estimate=True),
]}
