// 階層クラスタリングのタブ（ml-hclust の agnes）。
//
// 流れ: 分析範囲（母集団、または選択中）の行を DuckDB から取り出す → 上限を
// 超えたら無作為に間引く → Web Worker で行と列の樹形図を作る → クラスタ数
// （または樹形図を切る高さ）を決めて「階層クラスタ」列を書き戻す →
// クラスタ付きヒートマップ（行・列の樹形図つき）を描く。
//
// 書き戻した列は、既存の k-means の結果と同じく、グラフの色分け・カテゴリの
// 軸・絞り込みにそのまま使える（= クロスフィルタに参加する）。さらに
// ヒートマップの上でも連動させる:
//   - クラスタの色の帯をクリック → その クラスタを $brush で選ぶ
//   - 他のグラフで選んでいる行を、ヒートマップの横の細い帯に印で示す
// 樹形図とヒートマップは vgplot にマークが無いので、SVG を直接組み立てる。

import type { Coordinator } from '@uwdata/vgplot';
import type { Selection } from '@uwdata/mosaic-core';
import { clausePoints } from '@uwdata/mosaic-core';
import { column } from '@uwdata/mosaic-sql';
import { runInWorker, chooseFeatures, uniqueName, zExpr, exclusionNote } from './mlPanel';
import type { AnalysisScope, AddedColumns } from './mlPanel';
import { cutByCount, countAtHeight, leafLabels, autoClusterCount } from './ml';
import type { FlatTree, Linkage, Matrix } from './ml';
import { quoteIdent } from './sql';
import { escapeHtml, helpTip, toast } from './dom';
import { formatStat } from './stats';
import { PALETTE } from './categories';

// 階層クラスタリングに使う行数の上限。これを超えたら無作為に間引いて実行する。
// 根拠（docs/performance.md「階層クラスタリングの行数の上限」）: agnes は行数の
// ほぼ3乗で重くなる。目安は「実行を押してから2秒以内に結果が出る」こと。
// 実際のアプリで「実行」から図が出るまでを3ブラウザ × 3連結法で測ると（3回の中央値）、
//   800 行: どの組み合わせも 0.7〜1.0 秒
//   900 行: Chromium・WebKit は約1.1秒だが、Firefox の Ward 法が 2.4 秒
//   1,000 行: Firefox が 2.2〜2.7 秒（Chromium・WebKit は 1.2〜1.5 秒）
// 3ブラウザすべてで2秒を明確に下回る 800 行にした（Node.js だけで測った段階では
// 1,000 行で約1.2秒だったが、ブラウザ、特に Firefox では遅かった）。
export const MAX_HCLUST_ROWS = 800;
// クラスタ数の選択肢の上限（色分けの色が区別できる範囲）
const MAX_K = 10;
const COLUMN_NAME = '階層クラスタ';
// 欠測があって距離を測れず、クラスタを割り当てられない行
const UNASSIGNED = '（欠測あり）';

const LINKAGE_LABELS: Record<Linkage, string> = {
  ward: 'Ward 法',
  average: '平均連結法',
  complete: '完全連結法',
};

interface RunResult {
  rows: FlatTree;
  cols: FlatTree;
  Z: Matrix; // 表示用（列ごとの z 値）
  space: Matrix; // 距離を測った空間（標準化ありなら z 値、なしなら元の値）
  means: number[];
  sds: number[];
  features: string[];
  rowids: number[];
  standardize: boolean;
  method: Linkage;
  sampledFrom: number; // 間引く前の件数（欠測の無い行）
  incomplete: number;
  ms: number;
  scopeLabel: string;
}

/** クラスタ番号 → 表示名（大きい順に 1, 2, …）と、各サンプル行のラベル番号。 */
interface Cut {
  k: number;
  labels: number[]; // サンプル行ごとのクラスタ番号（大きい順に振り直した 0..k-1）
  sizes: number[];
  height: number; // 樹形図のどの高さで切ったか（表示用）
  auto: boolean;
}

export interface HClustPanelOptions {
  db: Coordinator;
  tableName: string;
  numericCols: string[];
  existingCols: string[];
  container: HTMLElement;
  brush: Selection;
  getScope: () => AnalysisScope;
  onColumnsAdded: (added: AddedColumns) => Promise<void>;
}

export interface HClustPanel {
  /** 選択が変わったとき（落ち着いてから）に呼ぶ。ヒートマップの選択の印を更新する。 */
  refreshSelection(): void;
  /** 選択の有無が変わったとき、「選択中だけで実行」の選択肢を有効・無効にする。 */
  refreshScope(): void;
}

/** クラスタ帯のクリックで $brush に入れる節の出どころ（toggle と同じ形）。 */
class ClusterSource {
  value: unknown[][] | null = null;
  fields: string[];
  constructor(field: string) {
    this.fields = [field];
  }
  reset() {
    this.value = null;
  }
}

export function createHClustPanel(opts: HClustPanelOptions): HClustPanel {
  const { db, tableName, container } = opts;
  const columnName = uniqueName(COLUMN_NAME, new Set(opts.existingCols));
  const source = new ClusterSource(columnName);
  let result: RunResult | null = null;
  let cut: Cut | null = null;
  let requestedK: number | null = null; // null = 自動
  let selectedRowids = new Set<number>();
  let running = false;

  container.innerHTML = `
    <p class="ml-intro">似た行を順にまとめていき、まとまり方を樹形図で見せます（階層クラスタリング）。樹形図を切る位置で、いくつのグループに分けるかを選べます。${helpTip(
      'すべての行を1つずつのグループから始め、いちばん近いグループどうしを繰り返し結合する。結合したときの距離が樹形図の高さ。Ward 法は結合でばらつきの増え方が最小になる組を、平均連結法は全ペアの平均距離が、完全連結法は最も遠いペアの距離が最小の組を選ぶ。'
    )}</p>
    <div class="ml-controls">
      <label>連結法 <select class="hc-method">
        <option value="ward">Ward 法（おすすめ）</option>
        <option value="average">平均連結法</option>
        <option value="complete">完全連結法</option>
      </select></label>
      <label class="inline-check"><input type="checkbox" class="hc-standardize" checked> 列ごとに標準化（z-score）</label>
      <label>対象 <select class="hc-scope">
        <option value="population">母集団すべて</option>
        <option value="selected">選択中の行だけ</option>
      </select></label>
      <button type="button" class="primary-button hc-run">実行</button>
    </div>
    <p class="note warn hc-standardize-note" hidden>
      標準化しないと、値の大きい列（単位が大きい列）が距離をほぼ決めてしまい、値の小さい列はほとんど効きません。
      単位が揃っている列どうしを比べたいとき以外は、標準化をおすすめします。
    </p>
    <div class="ml-status muted"></div>
    <div class="ml-body hc-body"><div class="ml-empty">「実行」を押すと、樹形図とクラスタ付きヒートマップがここに出ます。</div></div>`;

  const methodEl = container.querySelector<HTMLSelectElement>('.hc-method')!;
  const standardizeEl = container.querySelector<HTMLInputElement>('.hc-standardize')!;
  const scopeEl = container.querySelector<HTMLSelectElement>('.hc-scope')!;
  const runEl = container.querySelector<HTMLButtonElement>('.hc-run')!;
  const noteEl = container.querySelector<HTMLElement>('.hc-standardize-note')!;
  const statusEl = container.querySelector<HTMLElement>('.ml-status')!;
  const bodyEl = container.querySelector<HTMLElement>('.hc-body')!;

  standardizeEl.addEventListener('change', () => (noteEl.hidden = standardizeEl.checked));

  function refreshScope() {
    const has = opts.getScope().hasSelection;
    const option = scopeEl.querySelector<HTMLOptionElement>('option[value="selected"]')!;
    option.disabled = !has;
    option.textContent = has ? '選択中の行だけ' : '選択中の行だけ（グラフで選ぶと使えます）';
    if (!has && scopeEl.value === 'selected') scopeEl.value = 'population';
  }
  refreshScope();

  // ---- 実行 ----
  async function run() {
    if (running) return;
    running = true;
    runEl.disabled = true;
    bodyEl.classList.add('is-loading');
    statusEl.textContent = '行を取り出しています…';
    try {
      const scope = opts.getScope();
      const useSelection = scopeEl.value === 'selected' && scope.hasSelection;
      const where = useSelection ? scope.selectedSql : scope.populationSql;
      const features = await chooseFeatures(db, tableName, opts.numericCols, where);
      if (features.used.length < 2) {
        bodyEl.innerHTML = '<p class="muted">使える数値列が2つ未満のため、実行できません。</p>';
        statusEl.textContent = '';
        return;
      }
      const cols = features.used;
      const notNull = cols.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ');
      const t = quoteIdent(tableName);
      const [countRes, rowsRes]: any[] = await Promise.all([
        db.query(
          `SELECT count(*) FILTER (WHERE ${notNull}) AS complete, count(*) FILTER (WHERE NOT (${notNull})) AS incomplete FROM ${t} WHERE ${where}`,
          { cache: false }
        ),
        // 上限を超える分は hash(rowid) の順で間引く。乱数ではなくハッシュ順にするのは、
        // 同じ条件なら毎回同じ行が選ばれ、結果が再現するようにするため（ハッシュの順は
        // 元の並びと無関係なので、無作為抽出として扱える）
        db.query(
          `SELECT rowid AS __rid, ${cols.map((c, i) => `CAST(${quoteIdent(c)} AS DOUBLE) AS v${i}`).join(', ')} FROM ${t} WHERE (${where}) AND ${notNull} ORDER BY hash(rowid) LIMIT ${MAX_HCLUST_ROWS}`,
          { cache: false }
        ),
      ]);
      const complete = Number(countRes.get(0).complete);
      const incomplete = Number(countRes.get(0).incomplete);
      const rows: any[] = rowsRes.toArray();
      if (rows.length < 3) {
        bodyEl.innerHTML = `<p class="muted">欠測のない行が ${rows.length} 件しかなく、実行できません。</p>`;
        statusEl.textContent = '';
        return;
      }
      const X: Matrix = rows.map((r) => cols.map((_, i) => Number(r[`v${i}`])));
      const rowids = rows.map((r) => Number(r.__rid));
      statusEl.textContent = `${rows.length.toLocaleString()} 行で樹形図を計算しています…`;
      const method = methodEl.value as Linkage;
      const standardize = standardizeEl.checked;
      const res = await runInWorker({ type: 'hclust', X, method, standardize });
      if (res.type !== 'hclust') throw new Error(res.type === 'error' ? res.message : '想定外の応答');
      result = {
        rows: res.rows,
        cols: res.cols,
        Z: res.Z,
        space: standardize ? res.Z : X,
        means: res.means,
        sds: res.sds,
        features: cols,
        rowids,
        standardize,
        method,
        sampledFrom: complete,
        incomplete,
        ms: res.ms,
        scopeLabel: useSelection ? '選択中の行' : '母集団',
      };
      exclusion = exclusionNote(features, incomplete);
      await applyCut(requestedK);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error">⚠️ 実行に失敗しました: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
      statusEl.textContent = '';
    } finally {
      running = false;
      runEl.disabled = false;
      bodyEl.classList.remove('is-loading');
    }
  }
  let exclusion = '';
  runEl.addEventListener('click', run);

  // ---- 切る（クラスタ数を決めて列を書き戻す） ----
  async function applyCut(k: number | null) {
    if (!result) return;
    const tree = result.rows;
    const n = result.rowids.length;
    const auto = k === null;
    const chosenK = Math.max(2, Math.min(k ?? autoClusterCount(tree), MAX_K, n));
    const groups = cutByCount(tree, chosenK);
    const raw = leafLabels(tree, groups, n);
    // 大きいクラスタから 1, 2, … と番号を振り直す（「階層クラスタ1」が常に最大）
    const sizes0 = groups.map((_, g) => raw.filter((l) => l === g).length);
    const order = sizes0.map((_, g) => g).sort((a, b) => sizes0[b] - sizes0[a]);
    const rank = new Map(order.map((g, i) => [g, i]));
    const labels = raw.map((l) => rank.get(l)!);
    const sizes = order.map((g) => sizes0[g]);
    // 表示用の切る高さ: k 個に切るときに切り離す最後の結合と、その次の結合の中間
    const heights = tree.nodes.filter((nd) => nd.children.length).map((nd) => nd.height).sort((a, b) => b - a);
    const height = ((heights[chosenK - 2] ?? 0) + (heights[chosenK - 1] ?? 0)) / 2;
    cut = { k: groups.length, labels, sizes, height, auto };
    await writeBack();
    await refreshSelectionNow();
    render();
  }

  /**
   * 「階層クラスタ」列を書き戻す。間引いた行（と、選択中だけで実行したときの
   * 範囲外の行）にもクラスタを付けるため、各クラスタの重心（距離を測った空間での
   * 平均）に最も近いクラスタを SQL で割り当てる。行データを JS に戻さない。
   */
  async function writeBack() {
    if (!result || !cut) return;
    const { space, features, means, sds, standardize } = result;
    const k = cut.k;
    const p = features.length;
    const centroids = Array.from({ length: k }, () => new Array(p).fill(0));
    const counts = new Array(k).fill(0);
    space.forEach((row, i) => {
      const c = cut!.labels[i];
      counts[c]++;
      row.forEach((v, j) => (centroids[c][j] += v));
    });
    centroids.forEach((cen, c) => cen.forEach((_, j) => (cen[j] /= Math.max(counts[c], 1))));
    const valueExpr = (col: string, j: number) => (standardize ? zExpr(col, means[j], sds[j]) : `CAST(${quoteIdent(col)} AS DOUBLE)`);
    const dists = centroids.map((cen) => features.map((col, j) => `power(${valueExpr(col, j)} - (${cen[j]}), 2)`).join(' + '));
    const names = Array.from({ length: k }, (_, i) => `'${COLUMN_NAME}${i + 1}'`);
    const anyNull = features.map((c) => `${quoteIdent(c)} IS NULL`).join(' OR ');
    const table = quoteIdent(tableName);
    const col = quoteIdent(columnName);
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} VARCHAR`);
    await db.exec(
      `UPDATE ${table} SET ${col} = CASE WHEN ${anyNull} THEN '${UNASSIGNED}' ELSE [${names.join(', ')}][list_position([${dists
        .map((d) => `(${d})`)
        .join(', ')}], list_min([${dists.map((d) => `(${d})`).join(', ')}]))] END`
    );
    // 書き戻すとクラスタの顔ぶれが変わるので、この列でのクリック選択は外す
    const stale = opts.brush.clauses.filter((c) => c.source === source);
    if (stale.length) opts.brush.reset(stale);
    await opts.onColumnsAdded({ numeric: [], categorical: [columnName], color: columnName });
  }

  // ---- 選択の印 ----
  async function refreshSelectionNow() {
    if (!result) return;
    const scope = opts.getScope();
    if (!scope.hasSelection) {
      selectedRowids = new Set();
      return;
    }
    const res: any = await db.query(
      `SELECT rowid AS r FROM ${quoteIdent(tableName)} WHERE (${scope.selectedSql}) AND rowid IN (${result.rowids.join(', ')})`,
      { cache: false }
    );
    selectedRowids = new Set(res.toArray().map((r: any) => Number(r.r)));
  }

  function selectClusters(labels: string[]) {
    source.value = labels.length ? labels.map((l) => [l]) : null;
    opts.brush.update(clausePoints([column(columnName)], source.value ?? undefined, { source: source as any, clients: new Set() }));
  }

  // ---- 描画 ----
  let stripGeometry: { x: number; width: number; rowY: (i: number) => number; lineWidth: number } | null = null;

  /** 選択中の行の印だけを描き直す。 */
  function drawStrip() {
    const g = bodyEl.querySelector('.hc-strip');
    if (!g || !result || !stripGeometry) return;
    const { x, width, rowY, lineWidth } = stripGeometry;
    let d = '';
    result.rowids.forEach((rid, i) => {
      if (selectedRowids.has(rid)) d += `M${x},${rowY(i)}h${width}`;
    });
    g.innerHTML = d ? `<path d="${d}" stroke="#2563eb" stroke-width="${lineWidth}"/>` : '';
  }

  function render() {
    if (!result || !cut) return;
    const { rows: rowTree, cols: colTree, Z, features } = result;
    const n = result.rowids.length;
    const p = features.length;
    const W = Math.max(container.clientWidth, 520);
    const DENDRO_W = 150;
    const BAND_W = 16;
    const STRIP_W = 8;
    const COL_DENDRO_H = 60;
    const LABEL_H = 80;
    const H = Math.max(260, Math.min(480, n * 3));
    const x0 = DENDRO_W + 6 + BAND_W + 3 + STRIP_W + 4; // ヒートマップの左端
    const cellW = Math.max(18, Math.min(64, (W - x0 - 20) / p));
    const heatW = cellW * p;
    const y0 = COL_DENDRO_H + 4;
    const totalW = x0 + heatW + 20;
    const totalH = y0 + H + LABEL_H;
    const rowPos = new Array(n);
    rowTree.order.forEach((leaf, i) => (rowPos[leaf] = i));
    const rowY = (leaf: number) => y0 + ((rowPos[leaf] + 0.5) * H) / n;
    const colPos = new Array(p);
    colTree.order.forEach((leaf, i) => (colPos[leaf] = i));
    const colX = (leaf: number) => x0 + (colPos[leaf] + 0.5) * cellW;

    // 行の樹形図（左。根が左端、葉が右端）
    const maxH = rowTree.nodes[rowTree.root].height || 1;
    const hx = (h: number) => DENDRO_W * (1 - h / maxH);
    const ny: number[] = [];
    let rowPath = '';
    rowTree.nodes.forEach((node, i) => {
      if (node.leaf >= 0) {
        ny[i] = rowY(node.leaf);
        return;
      }
      const ys = node.children.map((c) => ny[c]);
      ny[i] = ys.reduce((s, v) => s + v, 0) / ys.length;
      const x = hx(node.height);
      for (const c of node.children) rowPath += `M${hx(rowTree.nodes[c].height)},${ny[c]}H${x}`;
      rowPath += `M${x},${Math.min(...ys)}V${Math.max(...ys)}`;
    });
    // 列の樹形図（上。根が上端、葉が下端）
    const maxHc = colTree.nodes[colTree.root].height || 1;
    const vy = (h: number) => COL_DENDRO_H * (1 - h / maxHc);
    const nx: number[] = [];
    let colPath = '';
    colTree.nodes.forEach((node, i) => {
      if (node.leaf >= 0) {
        nx[i] = colX(node.leaf);
        return;
      }
      const xs = node.children.map((c) => nx[c]);
      nx[i] = xs.reduce((s, v) => s + v, 0) / xs.length;
      const y = vy(node.height);
      for (const c of node.children) colPath += `M${nx[c]},${vy(colTree.nodes[c].height)}V${y}`;
      colPath += `M${Math.min(...xs)},${y}H${Math.max(...xs)}`;
    });

    // ヒートマップの本体は、1セル = 1画素の画像を引き伸ばして描く
    // （1,000 行 × 列数 の rect を並べると DOM が重くなるため）
    const canvas = document.createElement('canvas');
    canvas.width = p;
    canvas.height = n;
    const g2 = canvas.getContext('2d')!;
    const img = g2.createImageData(p, n);
    rowTree.order.forEach((leaf, r) => {
      colTree.order.forEach((colLeaf, c) => {
        const z = Z[leaf][colLeaf];
        const tz = Math.min(Math.abs(z) / 2.5, 1);
        const [cr, cg, cb] = z >= 0 ? [37, 99, 235] : [217, 72, 15];
        const o = (r * p + c) * 4;
        img.data[o] = Math.round(255 + (cr - 255) * tz);
        img.data[o + 1] = Math.round(255 + (cg - 255) * tz);
        img.data[o + 2] = Math.round(255 + (cb - 255) * tz);
        img.data[o + 3] = 255;
      });
    });
    g2.putImageData(img, 0, 0);

    // クラスタの帯（樹形図で切ったクラスタは葉の並びで連続している）
    const bandX = DENDRO_W + 6;
    let bands = '';
    let start = 0;
    const leafOrder = rowTree.order;
    for (let i = 1; i <= n; i++) {
      const prev = cut.labels[leafOrder[i - 1]];
      if (i === n || cut.labels[leafOrder[i]] !== prev) {
        const name = `${COLUMN_NAME}${prev + 1}`;
        const y1 = y0 + (start * H) / n;
        const y2 = y0 + (i * H) / n;
        bands += `<rect class="hc-band" data-cluster="${name}" x="${bandX}" y="${y1}" width="${BAND_W}" height="${y2 - y1}" fill="${PALETTE[prev % PALETTE.length]}"><title>${name}（${cut.sizes[prev].toLocaleString()} 件）クリックで選択</title></rect>`;
        start = i;
      }
    }
    // 選択中の行の印（中身は drawStrip が描く。選択が変わったときは、ここだけを
    // 描き直す。図全体を作り直すと、クリックの最中にボタンが差し替わって
    // クリックが失われることがあるため）
    const stripX = bandX + BAND_W + 3;
    stripGeometry = { x: stripX, width: STRIP_W, rowY, lineWidth: Math.max(1, H / n) };
    const strip = `<rect x="${stripX}" y="${y0}" width="${STRIP_W}" height="${H}" fill="#f0f2f5"/><g class="hc-strip"></g>`;
    const cutX = hx(cut.height);
    const colLabels = colTree.order
      .map(
        (leaf) =>
          `<text transform="translate(${colX(leaf)},${y0 + H + 8}) rotate(40)" font-size="11" fill="#3d4657">${escapeHtml(features[leaf])}</text>`
      )
      .join('');
    const svg = `
      <svg class="hc-svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">
        <rect class="hc-dendro-hit" x="0" y="${y0}" width="${DENDRO_W}" height="${H}" fill="transparent"><title>クリックした高さで樹形図を切る</title></rect>
        <path d="${rowPath}" fill="none" stroke="#687285" stroke-width="1" pointer-events="none"/>
        <line x1="${cutX}" x2="${cutX}" y1="${y0 - 4}" y2="${y0 + H + 4}" stroke="#c0262d" stroke-width="1.5" stroke-dasharray="4 3" pointer-events="none"/>
        <path d="${colPath}" transform="translate(0,0)" fill="none" stroke="#687285" stroke-width="1"/>
        ${bands}
        ${strip}
        <image href="${canvas.toDataURL()}" x="${x0}" y="${y0}" width="${heatW}" height="${H}" preserveAspectRatio="none" style="image-rendering:pixelated"/>
        <rect x="${x0}" y="${y0}" width="${heatW}" height="${H}" fill="none" stroke="#cfd6df"/>
        ${colLabels}
        <text x="${stripX + STRIP_W / 2}" y="${y0 - 6}" font-size="9" fill="#687285" text-anchor="middle">選択</text>
      </svg>`;

    const kOptions = [`<option value="" ${cut.auto ? 'selected' : ''}>自動（${cut.auto ? cut.k : autoClusterCount(rowTree)}）</option>`]
      .concat(
        Array.from({ length: MAX_K - 1 }, (_, i) => i + 2).map(
          (k) => `<option value="${k}" ${!cut!.auto && cut!.k === k ? 'selected' : ''}>${k}</option>`
        )
      )
      .join('');
    const sampled =
      result.sampledFrom > n
        ? `<strong>${result.sampledFrom.toLocaleString()} 件から ${n.toLocaleString()} 件に減らして実行</strong>（行数の上限 ${MAX_HCLUST_ROWS.toLocaleString()} 件を超えたため無作為に抽出）`
        : `${n.toLocaleString()} 件で実行`;
    const chips = cut.sizes
      .map(
        (size, i) =>
          `<button type="button" class="cluster-chip" data-cluster="${COLUMN_NAME}${i + 1}"><span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>${COLUMN_NAME}${i + 1}<small>${size.toLocaleString()} 件</small></button>`
      )
      .join('');
    statusEl.innerHTML = `対象: ${result.scopeLabel}・${sampled}・${LINKAGE_LABELS[result.method]}・標準化${result.standardize ? 'あり' : 'なし'}・計算 ${formatStat(result.ms / 1000)} 秒`;
    bodyEl.innerHTML = `
      <div class="hc-summary">
        <label>クラスタ数 <select class="hc-k">${kOptions}</select></label>
        <span class="muted">樹形図（左）の好きな高さをクリックしても切れます。自動は、樹形図の段差がいちばん大きい位置で切ります。</span>
      </div>
      <div class="hc-chips">${chips}</div>
      <p class="hint">「${escapeHtml(columnName)}」列を作り、散布図の色分けと絞り込みに加えました。色の帯・下のボタンをクリックすると、そのクラスタを選択します（Shift で複数）。
      セルの色は列ごとの z 値（<span class="chip-pos">青 = 平均より高い</span>・<span class="chip-neg">橙 = 低い</span>）。${
        result.standardize ? '' : '距離は標準化していない元の値で測っています（色だけは列ごとに揃えて表示）。'
      }</p>
      <div class="hc-scroll">${svg}</div>
      <p class="ml-note">行の並びは樹形図の葉の順（似た行が隣り合う）。列も列どうしの樹形図（上）の順に並べています。間引いた行と範囲外の行は、最も近いクラスタの重心に割り当てています。</p>
      ${exclusion}`;

    bodyEl.querySelector<HTMLSelectElement>('.hc-k')!.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      requestedK = v === '' ? null : Number(v);
      applyCut(requestedK);
    });
    const svgEl = bodyEl.querySelector<SVGSVGElement>('.hc-svg')!;
    svgEl.querySelector('.hc-dendro-hit')!.addEventListener('click', (e) => {
      const r = svgEl.getBoundingClientRect();
      const x = ((e as MouseEvent).clientX - r.left) * (totalW / r.width);
      const h = maxH * (1 - x / DENDRO_W);
      requestedK = Math.max(2, Math.min(MAX_K, countAtHeight(rowTree, h)));
      applyCut(requestedK);
    });
    drawStrip();
    const onPick = (name: string, shift: boolean) => {
      const current = (source.value ?? []).map((v) => String(v[0]));
      let next: string[];
      if (shift) next = current.includes(name) ? current.filter((c) => c !== name) : [...current, name];
      else next = current.length === 1 && current[0] === name ? [] : [name];
      selectClusters(next);
      toast(next.length ? `${next.join('・')} を選択しました` : 'クラスタの選択を解除しました');
    };
    bodyEl.querySelectorAll<SVGElement | HTMLElement>('[data-cluster]').forEach((el) =>
      el.addEventListener('click', (e) => onPick(el.getAttribute('data-cluster')!, (e as MouseEvent).shiftKey || (e as MouseEvent).metaKey))
    );
  }

  let refreshTimer: number | undefined;
  return {
    refreshSelection() {
      if (!result) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(async () => {
        await refreshSelectionNow();
        drawStrip();
      }, 50);
    },
    refreshScope,
  };
}
