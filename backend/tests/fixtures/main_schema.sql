CREATE TABLE activity (
	id VARCHAR(80) NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	source_id VARCHAR(80) NOT NULL, 
	sport VARCHAR(24) NOT NULL, 
	source_type VARCHAR(60) NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	start_utc DATETIME NOT NULL, 
	tz_offset_min INTEGER, 
	local_date DATE NOT NULL, 
	duration_s FLOAT, 
	moving_s FLOAT, 
	distance_m FLOAT, 
	avg_hr FLOAT, 
	max_hr FLOAT, 
	elevation_gain_m FLOAT, 
	calories FLOAT, 
	device VARCHAR(80) NOT NULL, 
	laps JSON NOT NULL, 
	stream_path TEXT, 
	raw_sha256 VARCHAR(64), 
	import_id VARCHAR(40), 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (source_id)
);
CREATE TABLE analysis (
	id VARCHAR(40) NOT NULL, 
	question TEXT NOT NULL, 
	code TEXT NOT NULL, 
	datasets JSON NOT NULL, 
	dataset_hash VARCHAR(64) NOT NULL, 
	rows JSON NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	result JSON NOT NULL, 
	duration_s FLOAT NOT NULL, 
	conversation_id VARCHAR(64), 
	runner VARCHAR(40) NOT NULL, 
	at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE athlete (
	id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	timezone VARCHAR(64) NOT NULL, 
	equipment TEXT NOT NULL, 
	availability TEXT NOT NULL, 
	notes TEXT NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE conversation (
	id VARCHAR(64) NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	history TEXT NOT NULL, 
	scopes JSON NOT NULL, 
	model VARCHAR(80) NOT NULL, 
	draft JSON, 
	PRIMARY KEY (id)
);
CREATE TABLE daily_metric (
	day DATE NOT NULL, 
	metric VARCHAR(40) NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	value FLOAT NOT NULL, 
	import_id VARCHAR(40), 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (day, metric, source)
);
CREATE TABLE dashboard_layout (
	section VARCHAR(40) NOT NULL, 
	version INTEGER NOT NULL, 
	items JSON NOT NULL, 
	at DATETIME NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	reason TEXT NOT NULL, 
	PRIMARY KEY (section, version)
);
CREATE TABLE exercise (
	id VARCHAR(80) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	role TEXT NOT NULL, 
	equipment JSON NOT NULL, 
	convention VARCHAR(80) NOT NULL, 
	notes TEXT NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE goal (
	id VARCHAR(80) NOT NULL, 
	season_id VARCHAR(80) NOT NULL, 
	sport VARCHAR(24) NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	target VARCHAR(80) NOT NULL, 
	event_date DATE, 
	priority VARCHAR(1) NOT NULL, 
	notes TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(season_id) REFERENCES season (id) ON DELETE CASCADE
);
CREATE TABLE import_run (
	id VARCHAR(40) NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	state VARCHAR(16) NOT NULL, 
	created_at DATETIME NOT NULL, 
	started_at DATETIME, 
	finished_at DATETIME, 
	params JSON NOT NULL, 
	progress JSON NOT NULL, 
	report JSON NOT NULL, 
	cancel_requested BOOLEAN NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE package_import (
	sha256 VARCHAR(64) NOT NULL, 
	package_id VARCHAR(80) NOT NULL, 
	package_version VARCHAR(40) NOT NULL, 
	at DATETIME NOT NULL, 
	change_id VARCHAR(40), 
	summary TEXT NOT NULL, 
	PRIMARY KEY (sha256)
);
CREATE TABLE phase (
	id VARCHAR(80) NOT NULL, 
	season_id VARCHAR(80) NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	start_date DATE NOT NULL, 
	end_date DATE NOT NULL, 
	position INTEGER NOT NULL, 
	guidance TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(season_id) REFERENCES season (id) ON DELETE CASCADE
);
CREATE TABLE plan_change (
	id VARCHAR(40) NOT NULL, 
	at DATETIME NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	reason TEXT NOT NULL, 
	summary TEXT NOT NULL, 
	weeks JSON NOT NULL, 
	ops JSON NOT NULL, 
	"before" JSON NOT NULL, 
	"after" JSON NOT NULL, 
	undoes_id VARCHAR(40), 
	undone_by_id VARCHAR(40), 
	op_id VARCHAR(80), 
	turn_id VARCHAR(40), 
	PRIMARY KEY (id), 
	UNIQUE (op_id)
);
CREATE TABLE planned_session (
	id VARCHAR(80) NOT NULL, 
	week_monday DATE NOT NULL, 
	local_date DATE, 
	position INTEGER NOT NULL, 
	sport VARCHAR(24) NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	tags JSON NOT NULL, 
	template_id VARCHAR(80), 
	template_version INTEGER, 
	prescription JSON NOT NULL, 
	priority VARCHAR(1) NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	logged JSON NOT NULL, 
	activity_id VARCHAR(80), 
	notes TEXT NOT NULL, 
	version INTEGER NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE principle_doc (
	version INTEGER NOT NULL, 
	markdown TEXT NOT NULL, 
	at DATETIME NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	reason TEXT NOT NULL, 
	PRIMARY KEY (version)
);
CREATE TABLE raw_asset (
	sha256 VARCHAR(64) NOT NULL, 
	kind VARCHAR(24) NOT NULL, 
	filename VARCHAR(300) NOT NULL, 
	path VARCHAR(400) NOT NULL, 
	size INTEGER NOT NULL, 
	import_id VARCHAR(40), 
	at DATETIME NOT NULL, 
	PRIMARY KEY (sha256)
);
CREATE TABLE season (
	id VARCHAR(80) NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	start_date DATE NOT NULL, 
	end_date DATE NOT NULL, 
	notes TEXT NOT NULL, 
	package_id VARCHAR(80), 
	PRIMARY KEY (id)
);
CREATE TABLE session_template (
	id VARCHAR(80) NOT NULL, 
	version INTEGER NOT NULL, 
	sport VARCHAR(24) NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	category VARCHAR(40) NOT NULL, 
	tags JSON NOT NULL, 
	prescription JSON NOT NULL, 
	equipment JSON NOT NULL, 
	default_priority VARCHAR(1) NOT NULL, 
	notes TEXT NOT NULL, 
	logging TEXT NOT NULL, 
	at DATETIME NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id, version)
);
CREATE TABLE setting (
	"key" VARCHAR(80) NOT NULL, 
	value JSON NOT NULL, 
	PRIMARY KEY ("key")
);
CREATE TABLE sleep_night (
	day DATE NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	start_utc DATETIME, 
	end_utc DATETIME, 
	tz_offset_min FLOAT, 
	deep_s FLOAT, 
	light_s FLOAT, 
	rem_s FLOAT, 
	awake_s FLOAT, 
	score FLOAT, 
	import_id VARCHAR(40), 
	PRIMARY KEY (day, source)
);
CREATE TABLE week (
	monday DATE NOT NULL, 
	season_id VARCHAR(80), 
	targets JSON NOT NULL, 
	notes TEXT NOT NULL, 
	deload BOOLEAN NOT NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (monday)
);
CREATE TABLE week_pattern (
	id VARCHAR(80) NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	sessions JSON NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_activity_local_date ON activity (local_date);
CREATE INDEX ix_activity_sport ON activity (sport);
CREATE INDEX ix_activity_start_utc ON activity (start_utc);
CREATE INDEX ix_analysis_at ON analysis (at);
CREATE INDEX ix_conversation_updated_at ON conversation (updated_at);
CREATE INDEX ix_import_run_state ON import_run (state);
CREATE INDEX ix_plan_change_at ON plan_change (at);
CREATE INDEX ix_planned_session_activity_id ON planned_session (activity_id);
CREATE INDEX ix_planned_session_week_monday ON planned_session (week_monday);
