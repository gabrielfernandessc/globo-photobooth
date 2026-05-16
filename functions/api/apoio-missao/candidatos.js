function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function pickFirst(source, keys, fallback = null) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== "") return source[key];
  }
  return fallback;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return 0;
    const normalized = raw
      .replace(/[R$\s]/gi, "")
      .replace(/\.(?=\d{3}(\D|$))/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function ensureHttpUrl(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("/")) return `https://queroapoiar.com.br${text}`;
  if (/^[a-z0-9-]+$/i.test(text)) return `https://queroapoiar.com.br/${text}`;
  return null;
}

function listFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const options = [
    payload.items,
    payload.data,
    payload.results,
    payload.rows,
    payload.candidatos,
    payload.campaigns,
  ];

  for (const item of options) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function isMissaoParty(candidate) {
  const keywords = ["missao", "missão"];
  const party = normalizeText(candidate.partido || "");
  return keywords.some(keyword => party.includes(normalizeText(keyword)));
}

function resolveDonationUrl(candidate) {
  const rawUrl = pickFirst(candidate, [
    "linkDoacao",
    "link_doacao",
    "urlDoacao",
    "url_doacao",
    "campanhaUrl",
    "campaignUrl",
    "publicUrl",
    "urlPublica",
    "url",
  ]);

  if (rawUrl) return ensureHttpUrl(rawUrl);
  const slug = pickFirst(candidate, ["slug", "campanhaSlug"]);
  return slug ? `https://queroapoiar.com.br/${slug}` : null;
}

function normalizeCandidate(candidate) {
  const campaign = candidate?.campanha || {};
  const metrics = candidate?.metricas || candidate?.metrics || candidate?.resumo || {};

  const nome = pickFirst(candidate, ["nomeUrna", "nome_urna", "nome", "name"]) || "Sem nome";
  const totalArrecadado = toNumber(
    pickFirst(candidate, ["totalArrecadado", "arrecadado", "valorArrecadado"]) ??
      pickFirst(metrics, ["totalArrecadado", "arrecadado", "valorArrecadado"]) ??
      pickFirst(campaign, ["totalArrecadado", "arrecadado"])
  );
  const totalDoacoes = toNumber(
    pickFirst(candidate, ["totalDoacoes", "quantidadeDoacoes", "qtdDoacoes"]) ??
      pickFirst(metrics, ["totalDoacoes", "quantidadeDoacoes"])
  );
  const metaArrecadacao = toNumber(
    pickFirst(candidate, ["metaArrecadacao", "meta", "goal"]) ??
      pickFirst(metrics, ["metaArrecadacao", "meta"]) ??
      pickFirst(campaign, ["metaArrecadacao", "meta"])
  );

  const percentualMeta = metaArrecadacao > 0
    ? (totalArrecadado / metaArrecadacao) * 100
    : toNumber(pickFirst(candidate, ["percentualMeta"]) ?? pickFirst(metrics, ["percentualMeta"]));

  return {
    id: pickFirst(candidate, ["cpf", "id", "_id", "uuid"]) || `cand-${Math.random().toString(36).slice(2, 10)}`,
    cpf: pickFirst(candidate, ["cpf", "documento", "document"]),
    nome,
    nomeUrna: pickFirst(candidate, ["nomeUrna", "nome_urna"]) || nome,
    partido:
      pickFirst(candidate, ["partido", "siglaPartido", "partidoSigla", "party"]) ||
      pickFirst(campaign, ["partido", "siglaPartido", "partidoSigla", "party"]) ||
      null,
    uf: pickFirst(candidate, ["uf", "estado", "state"]) || pickFirst(campaign, ["uf", "estado", "state"]) || null,
    cargo:
      pickFirst(candidate, ["cargoLabel", "cargo", "office", "tituloCargo"]) ||
      pickFirst(campaign, ["cargoLabel", "cargo", "office"]) ||
      null,
    cidade:
      pickFirst(candidate, ["cidade", "municipio", "city"]) ||
      pickFirst(campaign, ["cidade", "municipio", "city"]) ||
      null,
    fotoUrl: ensureHttpUrl(
      pickFirst(candidate, ["fotoUrl", "foto", "imagemUrl", "avatar", "image"]) ||
        pickFirst(campaign, ["fotoUrl", "imagemUrl", "avatar"])
    ),
    slug: pickFirst(candidate, ["slug", "campanhaSlug"]) || pickFirst(campaign, ["slug"]),
    donationUrl: resolveDonationUrl({
      ...candidate,
      campanhaSlug: pickFirst(candidate, ["campanhaSlug"]) || pickFirst(campaign, ["slug"]),
      linkDoacao: pickFirst(candidate, ["linkDoacao"]) || pickFirst(campaign, ["linkDoacao"]),
      url: pickFirst(candidate, ["url"]) || pickFirst(campaign, ["url"]),
    }),
    totalArrecadado,
    totalDoacoes,
    metaArrecadacao,
    ticketMedio: totalDoacoes > 0 ? totalArrecadado / totalDoacoes : 0,
    percentualMeta: Number.isFinite(percentualMeta) ? percentualMeta : 0,
    status: pickFirst(candidate, ["status", "situacao"]) || pickFirst(campaign, ["status", "situacao"]) || null,
  };
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export async function onRequestGet(context) {
  const apiBase = (context.env.QA_API_BASE || "https://api.queroapoiar.com.br").replace(/\/+$/, "");
  const apiKey = context.env.QA_API_KEY;

  if (!apiKey) {
    return json(
      { error: "QA_API_KEY não configurada no Cloudflare Pages (Variables & Secrets)." },
      { status: 500 }
    );
  }

  try {
    const { searchParams } = new URL(context.request.url);
    const uf = searchParams.get("uf") || "";
    const cargo = searchParams.get("cargo") || "";
    const busca = searchParams.get("busca") || "";
    const limite = searchParams.get("limite") || "500";

    const endpoint = `${apiBase}/api/parceiros/candidatos?limite=${encodeURIComponent(limite)}`;
    const response = await fetch(endpoint, {
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const rawText = await response.text();
    if (!response.ok) {
      return json(
        {
          error: "Falha ao buscar dados da API do QueroApoiar",
          detail: `Status ${response.status}: ${rawText.slice(0, 180)}`,
        },
        { status: 502 }
      );
    }

    const payload = rawText ? JSON.parse(rawText) : {};
    const normalized = listFromPayload(payload).map(normalizeCandidate);
    const missaoOnly = normalized.filter(isMissaoParty);
    const hasAnyPartyInfo = normalized.some(candidate => !!candidate.partido);
    const scopedCandidates = missaoOnly.length > 0 ? missaoOnly : (hasAnyPartyInfo ? [] : normalized);

    const ufFilter = normalizeText(uf);
    const cargoFilter = normalizeText(cargo);
    const buscaFilter = normalizeText(busca);

    const filtered = scopedCandidates.filter(candidate => {
      if (ufFilter && normalizeText(candidate.uf) !== ufFilter) return false;
      if (cargoFilter && normalizeText(candidate.cargo) !== cargoFilter) return false;
      if (buscaFilter) {
        const haystack = normalizeText(
          [
            candidate.nome,
            candidate.nomeUrna,
            candidate.uf,
            candidate.cargo,
            candidate.cidade,
            candidate.slug,
          ]
            .filter(Boolean)
            .join(" ")
        );
        if (!haystack.includes(buscaFilter)) return false;
      }
      return true;
    });

    const totals = filtered.reduce(
      (acc, item) => {
        acc.totalArrecadado += item.totalArrecadado;
        acc.totalDoacoes += item.totalDoacoes;
        acc.totalMeta += item.metaArrecadacao;
        return acc;
      },
      { totalArrecadado: 0, totalDoacoes: 0, totalMeta: 0 }
    );

    const ufs = [...new Set(scopedCandidates.map(c => c.uf).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), "pt-BR")
    );
    const cargos = [...new Set(scopedCandidates.map(c => c.cargo).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), "pt-BR")
    );

    return json({
      source: endpoint,
      total: filtered.length,
      filters: { uf: uf || null, cargo: cargo || null, busca: busca || null },
      aggregate: {
        totalArrecadado: totals.totalArrecadado,
        totalDoacoes: totals.totalDoacoes,
        totalMeta: totals.totalMeta,
        percentualMeta: totals.totalMeta > 0 ? (totals.totalArrecadado / totals.totalMeta) * 100 : 0,
      },
      facets: { ufs, cargos },
      items: filtered,
    });
  } catch (error) {
    return json(
      {
        error: "Erro inesperado ao processar candidatos",
        detail: error?.message || "unknown_error",
      },
      { status: 500 }
    );
  }
}

