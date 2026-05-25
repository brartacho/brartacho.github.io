-- ============================================================
-- N4 Vault de documentos + N8 Gmail threads + N25 Talent pool
-- ============================================================

-- N4 — Vault de documentos pessoais
create table if not exists personal_documents (
    id              uuid primary key default gen_random_uuid(),
    doc_type        text not null,                         -- 'rg'|'cpf'|'comprov_endereco'|'diploma'|'cert'|'cnh'|'foto'|'outro'
    display_name    text not null,
    filename        text not null,
    storage_path    text not null,                         -- path no bucket 'vault' do Supabase Storage
    mime_type       text not null,
    size_bytes      int,
    validade        date,                                  -- expiração (CNH, certidões, etc.)
    tags            text[] default '{}',
    notes           text,
    hash_sha256     text,                                  -- detecta duplicatas
    uploaded_at     timestamptz default now(),
    last_used_at    timestamptz,
    use_count       int default 0
);

create index if not exists idx_personal_docs_type on personal_documents(doc_type);
create index if not exists idx_personal_docs_validade on personal_documents(validade) where validade is not null;

-- N8 — Vínculos Gmail ↔ candidatura
create table if not exists email_thread_links (
    id               uuid primary key default gen_random_uuid(),
    thread_id        text not null unique,                 -- Gmail thread ID
    application_id   uuid references job_applications(id) on delete set null,
    vaga_radar_id    uuid references vaga_radar(id) on delete set null,
    link_confidence  numeric,                              -- 0-1
    link_method      text,                                 -- 'domain' | 'keyword' | 'manual' | 'reply_to'
    first_seen_at    timestamptz default now(),
    last_email_at    timestamptz,
    email_count      int default 0,
    unread_count     int default 0,
    subject_snippet  text,
    sender_name      text,
    sender_email     text,
    status           text default 'auto'                   -- 'auto' | 'confirmed' | 'rejected' | 'unrelated'
);

create index if not exists idx_email_thread_links_app
    on email_thread_links(application_id);

-- N25 — Talent pool / CRM enxuto
create table if not exists contacts (
    id                      uuid primary key default gen_random_uuid(),
    name                    text not null,
    role                    text,
    empresa                 text,
    email                   text,
    phone                   text,
    linkedin_url            text,
    source                  text,                          -- 'vaga:uuid' | 'meetup' | 'indicacao' | 'manual'
    source_ref              text,
    relationship_strength   int default 3,                 -- 1-5
    notes                   text,
    tags                    text[] default '{}',
    preferred_contact_method text,                         -- 'whatsapp' | 'linkedin' | 'email' | 'phone'
    contact_frequency_months int default 6,
    last_contact_at         timestamptz,
    last_contact_via        text,
    next_touch_at           timestamptz,                   -- computado: last_contact + frequency
    created_at              timestamptz default now(),
    updated_at              timestamptz default now()
);

create index if not exists idx_contacts_next_touch
    on contacts(next_touch_at) where next_touch_at is not null;
create index if not exists idx_contacts_empresa
    on contacts(empresa) where empresa is not null;

create table if not exists contact_interactions (
    id              uuid primary key default gen_random_uuid(),
    contact_id      uuid not null references contacts(id) on delete cascade,
    interaction_at  timestamptz default now(),
    channel         text,                                  -- 'whatsapp'|'email'|'linkedin'|'in_person'|'call'
    direction       text,                                  -- 'inbound' | 'outbound'
    summary         text,
    topics          text[],
    created_at      timestamptz default now()
);

create index if not exists idx_contact_interactions_contact
    on contact_interactions(contact_id, interaction_at desc);
