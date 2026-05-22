import { requireAdmin, cors } from '../_lib/auth.js';
import { getSupabase, BUCKET } from '../_lib/supabase.js';
import { normalizeFileName } from '../_lib/filename.js';

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!await requireAdmin(req, res)) return;

    const supabase = getSupabase();

    if (req.method === 'GET') {
        const { data, error } = await supabase
            .from('cv_versions')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data ?? []);
    }

    if (req.method === 'POST') {
        const { name, description, file_path, file_name } = req.body || {};
        if (!name || !file_path || !file_name) {
            return res.status(400).json({ error: 'Campos obrigatórios: name, file_path, file_name' });
        }

        const trimmedName = name.trim();
        const { data: dup } = await supabase
            .from('cv_versions')
            .select('id')
            .ilike('name', trimmedName)
            .maybeSingle();
        if (dup) return res.status(409).json({ error: `Já existe um currículo com o nome "${trimmedName}". Use um nome diferente.` });

        const cleanFileName = normalizeFileName(file_name);

        const { data, error } = await supabase
            .from('cv_versions')
            .insert({ name: trimmedName, description, file_path, file_name: cleanFileName, active: true })
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }

    if (req.method === 'PATCH') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'ID obrigatório (query string)' });

        const { name, description, active, file_name, target_role, search_keywords } = req.body || {};
        const patch = {};
        if (typeof name === 'string') {
            const trimmed = name.trim();
            if (!trimmed) return res.status(400).json({ error: 'Nome não pode ser vazio' });
            const { data: dup } = await supabase
                .from('cv_versions')
                .select('id')
                .ilike('name', trimmed)
                .neq('id', id)
                .maybeSingle();
            if (dup) return res.status(409).json({ error: `Já existe um currículo com o nome "${trimmed}". Use um nome diferente.` });
            patch.name = trimmed;
        }
        if (typeof file_name === 'string') {
            const normalized = normalizeFileName(file_name.trim());
            if (!normalized || normalized === 'arquivo.pdf') return res.status(400).json({ error: 'Nome de arquivo inválido' });
            patch.file_name = normalized;
        }
        if (typeof description === 'string') patch.description = description.trim() || null;
        if (typeof active === 'boolean') patch.active = active;
        if (typeof target_role === 'string') patch.target_role = target_role.trim() || null;
        if (Array.isArray(search_keywords)) patch.search_keywords = search_keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'Nenhum campo válido para atualizar (name, file_name, description, active, target_role ou search_keywords)' });
        }

        const { data, error } = await supabase
            .from('cv_versions')
            .update(patch)
            .eq('id', id)
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Versão não encontrada' });
        return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'ID obrigatório (query string)' });

        const { data: cv } = await supabase
            .from('cv_versions')
            .select('file_path')
            .eq('id', id)
            .single();

        if (!cv) return res.status(404).json({ error: 'Versão não encontrada' });

        await supabase.storage.from(BUCKET()).remove([cv.file_path]);

        const { error } = await supabase.from('cv_versions').delete().eq('id', id);
        if (error) return res.status(500).json({ error: error.message });

        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
