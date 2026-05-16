(() => {
  'use strict';

  const ufSelect = document.getElementById('filter-uf');
  const cargoSelect = document.getElementById('filter-cargo');
  const buscaInput = document.getElementById('filter-busca');
  const refreshButton = document.getElementById('btn-refresh');
  const tbody = document.getElementById('candidates-body');
  const statusLine = document.getElementById('status-line');

  const metricCandidatos = document.getElementById('metric-candidatos');
  const metricArrecadado = document.getElementById('metric-arrecadado');
  const metricDoacoes = document.getElementById('metric-doacoes');
  const metricMeta = document.getElementById('metric-meta');

  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const integer = new Intl.NumberFormat('pt-BR');

  let debounceId = null;
  let facetsInitialized = false;

  function setStatus(message) {
    statusLine.textContent = message;
  }

  function queryString() {
    const query = new URLSearchParams();
    const uf = ufSelect.value;
    const cargo = cargoSelect.value;
    const busca = buscaInput.value.trim();

    if (uf) query.set('uf', uf);
    if (cargo) query.set('cargo', cargo);
    if (busca) query.set('busca', busca);

    return query.toString();
  }

  function createOption(value, text) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    return option;
  }

  function updateFacets(facets) {
    if (facetsInitialized) return;

    const ufs = Array.isArray(facets?.ufs) ? facets.ufs : [];
    const cargos = Array.isArray(facets?.cargos) ? facets.cargos : [];

    ufs.forEach(uf => ufSelect.appendChild(createOption(uf, uf)));
    cargos.forEach(cargo => cargoSelect.appendChild(createOption(cargo, cargo)));

    facetsInitialized = true;
  }

  function renderMetrics(payload) {
    metricCandidatos.textContent = integer.format(payload.total || 0);
    metricArrecadado.textContent = brl.format(payload.aggregate?.totalArrecadado || 0);
    metricDoacoes.textContent = integer.format(payload.aggregate?.totalDoacoes || 0);

    const percent = Number(payload.aggregate?.percentualMeta || 0);
    metricMeta.textContent = `${percent.toFixed(1)}%`;
  }

  function donationCell(candidate) {
    if (!candidate.donationUrl) return '<span class="donate-link is-disabled">Sem link</span>';
    return `<a class="donate-link" href="${candidate.donationUrl}" target="_blank" rel="noopener noreferrer">Doar</a>`;
  }

  function renderRows(items) {
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhum candidato encontrado com esses filtros.</td></tr>';
      return;
    }

    tbody.innerHTML = items.map(candidate => {
      const nome = candidate.nomeUrna || candidate.nome || 'Sem nome';
      const meta = Number(candidate.metaArrecadacao || 0);
      const metaText = meta > 0
        ? `${brl.format(meta)} (${Number(candidate.percentualMeta || 0).toFixed(1)}%)`
        : 'Não informada';

      return `
        <tr>
          <td>
            <div class="candidate-name">${nome}</div>
            <div class="candidate-sub">${candidate.cidade || '-'} ${candidate.partido ? `• ${candidate.partido}` : ''}</div>
          </td>
          <td>${candidate.uf || '-'}</td>
          <td>${candidate.cargo || '-'}</td>
          <td>${brl.format(Number(candidate.totalArrecadado || 0))}</td>
          <td>${integer.format(Number(candidate.totalDoacoes || 0))}</td>
          <td>${metaText}</td>
          <td>${donationCell(candidate)}</td>
        </tr>
      `;
    }).join('');
  }

  async function loadCandidates() {
    setStatus('Carregando dados do QueroApoiar...');
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Buscando candidatos...</td></tr>';

    try {
      const query = queryString();
      const url = query ? `/api/apoio-missao/candidatos?${query}` : '/api/apoio-missao/candidatos';

      const response = await fetch(url, { cache: 'no-store' });
      const payload = await response.json();

      if (!response.ok) {
        const detail = payload?.detail ? ` (${payload.detail})` : '';
        throw new Error((payload?.error || 'Falha ao buscar candidatos') + detail);
      }

      updateFacets(payload.facets);
      renderMetrics(payload);
      renderRows(payload.items || []);

      const now = new Date();
      setStatus(`Atualizado em ${now.toLocaleTimeString('pt-BR')} • ${payload.total || 0} candidatos`);
    } catch (error) {
      renderMetrics({ total: 0, aggregate: { totalArrecadado: 0, totalDoacoes: 0, percentualMeta: 0 } });
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${error.message}</td></tr>`;
      setStatus('Erro ao carregar dados');
    }
  }

  function onFiltersChanged() {
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(loadCandidates, 280);
  }

  ufSelect.addEventListener('change', onFiltersChanged);
  cargoSelect.addEventListener('change', onFiltersChanged);
  buscaInput.addEventListener('input', onFiltersChanged);
  refreshButton.addEventListener('click', loadCandidates);

  loadCandidates();
})();
