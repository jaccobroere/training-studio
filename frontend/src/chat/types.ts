/** Assistant-side shapes (API.md → Assistant, Analyses and Pinned). Kept here, next to the chat. */
import type { ChartV2 } from "../charts/spec";

interface Usage { used: number; limit: number; resets_at: string; exhausted: boolean }

export interface AttachmentRules { images: boolean; pdf: boolean; max_per_message: number; max_mb: number; types: string[] }

export interface ChatStatus {
  configured: boolean;
  provider: string;
  model: string;
  usage: Usage;
  consent: boolean;
  /** The consent text: where messages, attachments and data read go. */
  note: string;
  attachments?: AttachmentRules;
  limits?: { per_minute: number };
}

/** POST /api/chat/attachments → the stored file. */
export interface Media {
  id: string; file: string; url: string; purpose: "entity" | "chat"; media_type: string; filename: string; size: number;
  width?: number | null; height?: number | null; pages?: number | null; has_text?: boolean; rendered_pages?: number;
}

/** What a sent user message carries in `metadata.attachments`. */
export interface MessageAttachment { id: string; filename: string; media_type: string; pages?: number | null; url: string }

export interface ToolMeta { label?: string; source?: string; summary?: string; ok?: boolean; error?: string; detail?: string }

export interface ChangeOut extends ToolMeta {
  saved?: boolean; change_id?: string; lines?: string[]; weeks?: string[]; kept?: { id: string; title: string; note: string }[];
  proposal_id?: string | null; converted?: string;
}

export interface ProposeOut extends ToolMeta {
  saved?: false; proposal_id?: string | null; status?: string; title?: string; lines?: string[]; n_lines?: number;
  counts?: Record<string, number>; weeks?: string[]; replaced?: string[];
}

export interface AnalysisOut extends ToolMeta {
  analysis_id?: string; status?: "ok" | "error" | "timeout" | "failed"; rows?: Record<string, number>;
  title?: string; stdout?: string; duration_s?: number; warnings?: string[];
  /** Failure details for one retry. */
  line?: number | null; code_line?: string | null; hint?: string | null; runs_left?: number | null; next?: string | null;
}

export interface PinOut extends ToolMeta { created?: boolean; updated?: boolean; removed?: boolean; pinned_id?: string; title?: string; version?: number }

export interface TableT { title?: string; columns: string[]; rows: unknown[][] }

export interface AnalysisResult {
  stdout?: string; truncated?: boolean; error?: string | null;
  error_brief?: { message: string; line?: number | null; code?: string | null; hint?: string | null } | null;
  charts?: ChartV2[]; tables?: TableT[]; warnings?: string[];
}

interface DatasetSpec { name: string; kind: string; start?: string; end?: string; type?: string | null }
interface RangeT { name: string; kind: string; start: string; end: string }

export interface Analysis {
  id: string; question: string; title: string; code: string; datasets: DatasetSpec[]; ranges?: RangeT[];
  dataset_hash: string; rows: Record<string, number>; status: "ok" | "error" | "timeout" | "failed";
  result: AnalysisResult; duration_s: number; at: string;
  data_changed_since: boolean | null; pinned_id: string | null;
}

export interface Pinned {
  id: string; title: string; code: string; datasets: DatasetSpec[]; position: number;
  created_from: string | null; version: number; created_at: string; updated_at: string;
}

export interface PinnedRun {
  pinned: Pinned; status: "ok" | "error" | "timeout" | "failed"; result: AnalysisResult;
  rows: Record<string, number>; ranges: RangeT[]; dataset_hash: string; duration_s: number; ran_at: string; cached: boolean;
}
