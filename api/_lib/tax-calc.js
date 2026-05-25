// Calculadora CLT vs PJ vs MEI — estimativas para o ano fiscal 2026
// Disclaimer: estimativas baseadas em alíquotas vigentes em 2026.
// Não substitui orientação de contador ou advogado tributarista.

// Tabela progressiva INSS empregado 2026 (faixas mensais)
const INSS_FAIXAS = [
    { max: 1518.00,  aliq: 0.075 },
    { max: 2793.88,  aliq: 0.090 },
    { max: 4190.83,  aliq: 0.120 },
    { max: 8157.41,  aliq: 0.140 },
];
const INSS_TETO = 1140.41; // teto INSS mensal 2026

function calcInssEmpregado(bruto) {
    let total = 0, prev = 0;
    for (const faixa of INSS_FAIXAS) {
        if (bruto <= prev) break;
        const base = Math.min(bruto, faixa.max) - prev;
        total += base * faixa.aliq;
        prev = faixa.max;
        if (bruto <= faixa.max) break;
    }
    return Math.min(total, INSS_TETO);
}

// Tabela IRPF 2026 (base de cálculo anual)
const IRPF_FAIXAS = [
    { max: 30639.90, aliq: 0,     deduc: 0         },
    { max: 36529.80, aliq: 0.075, deduc: 2297.99   },
    { max: 48780.00, aliq: 0.150, deduc: 5037.44   },
    { max: 64110.00, aliq: 0.225, deduc: 8698.74   },
    { max: Infinity, aliq: 0.275, deduc: 11894.24  },
];
const DEDUCAO_DEPENDENTE = 189.59; // por dependente/mês

function calcIrpfMensal(baseAnual) {
    const row = IRPF_FAIXAS.find(r => baseAnual <= r.max) || IRPF_FAIXAS.at(-1);
    return Math.max(0, (baseAnual * row.aliq - row.deduc) / 12);
}

function r2(v) { return Math.round(v * 100) / 100; }

// ── CLT ──────────────────────────────────────────────────────
export function calcCLT({ salarioBruto, vr = 0, vt = 0, planoSaude = 0, dependentes = 0 }) {
    const bruto = Number(salarioBruto) || 0;
    const inss  = calcInssEmpregado(bruto);
    const deducDep = DEDUCAO_DEPENDENTE * (Number(dependentes) || 0);
    const baseIrAnual = Math.max(0, (bruto - inss - deducDep) * 12);
    const ir    = calcIrpfMensal(baseIrAnual);
    const liq   = bruto - inss - ir;
    const bensDiretos = Number(vr) + Number(vt) + Number(planoSaude);
    const totalEfetivo = liq + bensDiretos;

    // Benefícios indiretos (custo do empregador, não recebidos em cash)
    const fgts           = r2(bruto * 0.08);
    const decimoTerceiro = r2(bruto / 12);
    const ferias         = r2(bruto / 12 * (1 + 1 / 3));

    return {
        regime: 'CLT',
        bruto:            r2(bruto),
        inss:             r2(inss),
        ir:               r2(ir),
        liquido:          r2(liq),
        beneficios_diretos: r2(bensDiretos),
        total_efetivo:    r2(totalEfetivo),
        indiretos: { fgts, decimoTerceiro, ferias },
    };
}

// ── PJ Simples Nacional ──────────────────────────────────────
// Anexo III (serviços TI) — faixa 1 até R$ 180k/ano: 6%
// Pro-labore sugerido: ~28% do faturamento
export function calcPJ({ faturamentoBruto, aliquotaSimplesPct = 6, proLaboreRatio = 0.28 }) {
    const bruto     = Number(faturamentoBruto) || 0;
    const aliq      = Number(aliquotaSimplesPct) / 100;
    const simples   = bruto * aliq;
    const proLabore = bruto * Number(proLaboreRatio);
    const inssProLabore = calcInssEmpregado(proLabore);
    const baseIrAnual = Math.max(0, (proLabore - inssProLabore) * 12);
    const irProLabore = calcIrpfMensal(baseIrAnual);
    const liq       = bruto - simples - inssProLabore - irProLabore;

    return {
        regime: 'PJ (Simples)',
        bruto:            r2(bruto),
        simples_pct:      Number(aliquotaSimplesPct),
        simples:          r2(simples),
        pro_labore:       r2(proLabore),
        inss_pro_labore:  r2(inssProLabore),
        ir_pro_labore:    r2(irProLabore),
        liquido:          r2(liq),
        beneficios_diretos: 0,
        total_efetivo:    r2(liq),
    };
}

// ── MEI ──────────────────────────────────────────────────────
// DAS fixo 2026 (serviços + comércio): R$ 76,90/mês
// Lucro isento de IRPF: 32% do faturamento (serviços)
export function calcMEI({ faturamentoBruto, percentualIsentoIR = 32 }) {
    const bruto      = Number(faturamentoBruto) || 0;
    const das        = 76.90;
    const lucroIsento = bruto * (Number(percentualIsentoIR) / 100);
    // Base IRPF: faturamento total - lucro isento - DAS - isenção base
    const baseIrMensal = Math.max(0, bruto - lucroIsento - das - 2259.20);
    const ir = calcIrpfMensal(baseIrMensal * 12);
    const liq = bruto - das - ir;

    return {
        regime: 'MEI',
        bruto:            r2(bruto),
        das:              r2(das),
        ir:               r2(ir),
        liquido:          r2(liq),
        beneficios_diretos: 0,
        total_efetivo:    r2(liq),
    };
}
