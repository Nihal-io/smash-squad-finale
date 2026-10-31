create extension if not exists vector;

create table if not exists candidates (
  id text primary key,
  name text not null,
  gender text not null,
  college text not null,
  tier int not null,
  yoe int not null,
  skills text[] not null,
  projects text[] not null,
  bio text not null,
  visible_text text not null,
  redacted_text text not null,
  archetype text not null,
  planted text not null,
  planted_for text,
  flags text[] not null default '{}',
  emb_visible vector(384),
  emb_redacted vector(384)
);
create index if not exists candidates_emb_visible_hnsw on candidates using hnsw (emb_visible vector_cosine_ops);
create index if not exists candidates_emb_redacted_hnsw on candidates using hnsw (emb_redacted vector_cosine_ops);

create table if not exists llm_cache (
  key text primary key,
  model text not null,
  response jsonb not null,
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id text primary key,
  role_key text,
  jd_text text not null,
  status text not null default 'running',
  chaos jsonb not null default '{}',
  state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists run_events (
  id bigserial primary key,
  run_id text not null references runs(id) on delete cascade,
  seq int not null,
  node text not null,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists run_events_run on run_events(run_id, seq);

create table if not exists outbox (
  id bigserial primary key,
  run_id text not null,
  candidate_id text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  channel text not null,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists hr_feedback (
  id bigserial primary key,
  role_key text not null,
  run_id text,
  rejected_candidate_id text,
  reason text,
  preferred_skills text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists hr_feedback_role on hr_feedback(role_key);

create table if not exists spend (
  id bigserial primary key,
  run_id text,
  model text not null,
  input_tokens int not null,
  output_tokens int not null,
  cost_usd numeric not null,
  cached boolean not null default false,
  created_at timestamptz not null default now()
);
