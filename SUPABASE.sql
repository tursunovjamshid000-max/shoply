CREATE TABLE IF NOT EXISTS public.shoply_data (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.shoply_data ENABLE ROW LEVEL SECURITY;
