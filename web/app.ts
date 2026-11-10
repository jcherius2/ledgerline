/**
 * Ledgerline browser UI. AG Grid Community (loaded as a global from the UMD bundle) is the
 * centre of the screen; everything else is plain DOM. No framework, no build step beyond tsc.
 * All invoice data is written with textContent: nothing from PayPal is ever parsed as HTML.
 */
import type * as AG from 'ag-grid-community';

declare const agGrid: typeof AG;

type Tone = 'auto' | 'friendly' | 'neutral' | 'firm';
type Step = 'REMIND' | 'WAIT' | 'OFFER_PLAN' | 'WRITE_OFF';

interface Row {
  id: string;
  number: string;
  customer: string;
  email: string;
  status: string;
  display: string;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  total: number;
  due: number;
  paid: number;
  daysOverdue: number | null;
  reference: string;
  riskScore: number | null;
  riskLevel: string | null;
  riskReasons: string[];
  exposure: number | null;
  reminders: number;
  lastReminder: string | null;
  nextStep: Step | null;
  nextStepSource: 'agent' | 'rules' | null;
  nextStepWhy: string;
  pending: { id: string; kind: string }[];
}

interface Action {
  id: string;
  kind: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  customer: string | null;
  payload: Record<string, any>;
  origin: 'agent' | 'user';
  rationale: string | null;
  source: string | null;
  warnings: string[];
  calls: string[];
  digest: string;
}

interface Entry {
  seq: number;
  at: string;
  type: string;
  kind?: string;
  invoiceNumber?: string;
  origin?: string;
  detail?: Record<string, any>;
}

const KIND_LABEL: Record<string, string> = {
  REMIND: 'Send reminder',
  OFFER_PLAN: 'Offer a payment plan',
  CANCEL: 'Cancel invoice (write off)',
  SEND: 'Send invoice to customer',
  RECORD_PAYMENT: 'Record a payment',
  UPDATE_DRAFT: 'Update draft',
  DELETE_DRAFT: 'Delete draft',
  CREATE_DRAFT: 'Create draft invoice',
  WAIT: 'Wait',
};
const STEP_LABEL: Record<Step, string> = { REMIND: 'Remind', WAIT: 'Wait', OFFER_PLAN: 'Offer a plan', WRITE_OFF: 'Write off' };
const MESSAGE_KINDS = ['REMIND', 'OFFER_PLAN', 'CANCEL', 'SEND'];
const METHODS = ['BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'WIRE_TRANSFER', 'OTHER'];

const state = {
  rows: [] as Row[],
  actions: [] as Action[],
  entries: [] as Entry[],
  chain: { ok: true, entries: 0, brokenAt: null as number | null },
  today: '',
  selectedId: null as string | null,
  view: 'all',
  paying: false,
};
const tones = new Map<string, Tone>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isOpen = (status: string) => status === 'SENT' || status === 'UNPAID' || status === 'PARTIALLY_PAID';
const isPaid = (status: string) => status === 'PAID' || status === 'MARKED_AS_PAID' || status === 'PAID_EXTERNAL';
const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: number, currency: string) => `${currency} ${amount.format(value)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string | null, text?: string | null, children?: (Node | null | undefined)[],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  for (const c of children ?? []) if (c) e.append(c);
  return e;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Request failed (${res.status})`);
  return data as T;
}

let toastTimer = 0;
function toast(message: string, error = false): void {
  const t = $('toast');
  t.textContent = message;
  t.className = error ? 'show error' : 'show';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.className = ''; }, error ? 8000 : 4500);
}
const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), true);

// ---------------------------------------------------------------- grid

const VIEWS: { id: string; label: string; test: (r: Row) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'open', label: 'Open', test: (r) => isOpen(r.status) },
  { id: 'overdue', label: 'Overdue', test: (r) => (r.daysOverdue ?? 0) > 0 },
  { id: 'draft', label: 'Drafts', test: (r) => r.status === 'DRAFT' },
  { id: 'paid', label: 'Paid', test: (r) => isPaid(r.status) },
];

type CellParams = AG.ICellRendererParams<Row>;
const blank = () => h('span');

function statusCell(p: CellParams): HTMLElement {
  const r = p.data;
  if (!r || p.node.rowPinned) return blank();
  const cls = r.status === 'DRAFT' ? 'draft' : isPaid(r.status) ? 'paid' : r.status === 'CANCELLED' ? 'cancelled'
    : (r.daysOverdue ?? 0) > 0 ? 'overdue' : r.status === 'PARTIALLY_PAID' ? 'part' : '';
  return h('span', `badge ${cls}`, r.display);
}

function riskCell(p: CellParams): HTMLElement {
  const r = p.data;
  if (!r || p.node.rowPinned || r.riskScore === null) return blank();
  const fill = h('i');
  fill.style.width = `${r.riskScore}%`;
  return h('span', `risk ${r.riskLevel}`, null, [h('span', 'bar', null, [fill]), h('b', null, String(r.riskScore)), h('em', null, r.riskLevel)]);
}

function stepCell(p: CellParams): HTMLElement {
  const r = p.data;
  if (!r || p.node.rowPinned) return blank();
  const parts: HTMLElement[] = [];
  if (r.nextStep) {
    parts.push(h('span', r.nextStep === 'WAIT' ? 'what wait' : 'what', STEP_LABEL[r.nextStep]));
    if (!r.pending.length) parts.push(h('span', r.nextStepSource === 'agent' ? 'by agent' : 'by', r.nextStepSource === 'agent' ? 'agent' : 'rule'));
  }
  if (r.pending.length) parts.push(h('span', 'held', 'to confirm'));
  return h('span', 'step', null, parts);
}

const moneyFormat = (p: AG.ValueFormatterParams<Row>) => (typeof p.value === 'number' ? amount.format(p.value) : '');
const draftOnly = (p: { data?: Row; node: AG.IRowNode<Row> | null }) => !p.node?.rowPinned && p.data?.status === 'DRAFT';
const openOnly = (p: { data?: Row; node: AG.IRowNode<Row> | null }) => !p.node?.rowPinned && !!p.data && isOpen(p.data.status);

const columnDefs: AG.ColDef<Row>[] = [
  { field: 'number', headerName: 'Invoice', pinned: 'left', width: 104, filter: 'agTextColumnFilter', cellClass: 'mono' },
  { field: 'customer', headerName: 'Customer', minWidth: 150, flex: 1, filter: 'agTextColumnFilter', tooltipField: 'email' },
  { field: 'display', headerName: 'Status', width: 124, filter: 'agTextColumnFilter', cellRenderer: statusCell },
  {
    field: 'daysOverdue', headerName: 'Days late', width: 100, type: 'rightAligned', filter: 'agNumberColumnFilter', cellClass: 'num',
    valueFormatter: (p) => (typeof p.value === 'number' && p.value > 0 ? String(p.value) : ''),
    cellClassRules: { late: (p) => typeof p.value === 'number' && p.value > 30 },
  },
  { field: 'due', headerName: 'Open', width: 108, type: 'rightAligned', filter: 'agNumberColumnFilter',
    valueFormatter: (p) => (typeof p.value === 'number' && p.value !== 0 ? amount.format(p.value) : ''), cellClass: 'num' },
  { field: 'currency', headerName: 'Cur.', width: 84, filter: 'agTextColumnFilter', cellClass: 'mono' },
  {
    field: 'riskScore', headerName: 'Risk', width: 148, filter: 'agNumberColumnFilter', sort: 'desc', cellRenderer: riskCell,
    tooltipValueGetter: (p) => (p.data?.riskReasons.length ? p.data.riskReasons.join('. ') : null),
  },
  {
    field: 'nextStep', headerName: 'Next step', width: 178, filter: 'agTextColumnFilter', cellRenderer: stepCell, tooltipField: 'nextStepWhy',
  },
  {
    field: 'reminders', headerName: 'Reminders', width: 112, type: 'rightAligned', filter: 'agNumberColumnFilter', cellClass: 'num',
    valueFormatter: (p) => (typeof p.value === 'number' && p.value > 0 ? String(p.value) : ''),
  },
  {
    colId: 'tone', headerName: 'Tone', width: 104, sortable: false, filter: false,
    editable: openOnly, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['auto', 'friendly', 'neutral', 'firm'] },
    valueGetter: (p) => (p.node?.rowPinned || !p.data || !isOpen(p.data.status) ? '' : tones.get(p.data.id) ?? 'auto'),
    valueSetter: (p) => { tones.set(p.data.id, p.newValue as Tone); return true; },
    cellClassRules: { 'can-edit': openOnly },
  },
  {
    field: 'dueDate', headerName: 'Due', width: 116, cellDataType: 'dateString', filter: 'agDateColumnFilter', cellClass: 'mono',
    editable: draftOnly, cellEditor: 'agDateStringCellEditor', cellClassRules: { 'can-edit': draftOnly },
  },
  { field: 'total', headerName: 'Billed', width: 112, type: 'rightAligned', filter: 'agNumberColumnFilter', valueFormatter: moneyFormat, cellClass: 'num' },
  { field: 'reference', headerName: 'Reference', width: 128, filter: 'agTextColumnFilter', editable: draftOnly, cellClassRules: { 'can-edit': draftOnly } },
  { field: 'invoiceDate', headerName: 'Issued', width: 116, cellDataType: 'dateString', filter: 'agDateColumnFilter', cellClass: 'mono' },
];

const theme = agGrid.themeQuartz.withParams({
  backgroundColor: '#fbfaf6',
  foregroundColor: '#1d1c1a',
  accentColor: '#1f5c4a',
  borderColor: '#d8d2c3',
  headerBackgroundColor: '#ece7da',
  headerTextColor: '#4a463e',
  headerFontWeight: 600,
  headerFontSize: 12,
  fontFamily: 'inherit',
  fontSize: 13,
  rowHeight: 38,
  headerHeight: 38,
  spacing: 6,
  oddRowBackgroundColor: '#fbfaf6',
  rowHoverColor: '#f1ecdf',
  selectedRowBackgroundColor: '#e1ece6',
  pinnedRowBackgroundColor: '#ece7da',
  pinnedRowFontWeight: 600,
  wrapperBorderRadius: 3,
  borderRadius: 2,
});

let lastTotals = '';
function updateTotals(): void {
  const by = new Map<string, { total: number; due: number; n: number }>();
  grid.forEachNodeAfterFilter((node) => {
    const r = node.data;
    if (!r) return;
    const t = by.get(r.currency) ?? { total: 0, due: 0, n: 0 };
    t.total += r.total;
    t.due += r.due;
    t.n += 1;
    by.set(r.currency, t);
  });
  const pinned: Row[] = [...by.entries()].sort().map(([currency, t]) => ({
    id: `total-${currency}`, number: 'Total', customer: `${t.n} invoice${t.n === 1 ? '' : 's'} shown`, email: '',
    status: 'TOTAL', display: '', invoiceDate: null, dueDate: null, currency, total: round2(t.total), due: round2(t.due), paid: 0,
    daysOverdue: null, reference: '', riskScore: null, riskLevel: null, riskReasons: [], exposure: null, reminders: 0,
    lastReminder: null, nextStep: null, nextStepSource: null, nextStepWhy: '', pending: [],
  }));
  const key = JSON.stringify(pinned);
  if (key === lastTotals) return;
  lastTotals = key;
  grid.setGridOption('pinnedBottomRowData', pinned);
}

const gridOptions: AG.GridOptions<Row> = {
  theme,
  columnDefs,
  rowData: [],
  defaultColDef: { sortable: true, resizable: true },
  getRowId: (p) => p.data.id,
  rowSelection: {
    mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false,
    isRowSelectable: (node) => !!node.data && isOpen(node.data.status),
  },
  selectionColumnDef: { pinned: 'left', width: 44 },
  rowClassRules: { dim: (p) => p.data?.status === 'CANCELLED' },
  tooltipShowDelay: 300,
  stopEditingWhenCellsLoseFocus: true,
  isExternalFilterPresent: () => state.view !== 'all',
  doesExternalFilterPass: (node) => !!node.data && (VIEWS.find((v) => v.id === state.view)?.test(node.data) ?? true),
  onModelUpdated: () => updateTotals(),
  onSelectionChanged: () => renderAskLabel(),
  onRowClicked: (e) => {
    if (e.node.rowPinned || !e.data) return;
    state.selectedId = e.data.id;
    state.paying = false;
    renderDetail();
  },
  onCellValueChanged: (e) => {
    const field = e.colDef.field;
    if (e.data && (field === 'dueDate' || field === 'reference')) void stageDraftEdit(e.data, field, e.newValue);
  },
};

const grid: AG.GridApi<Row> = agGrid.createGrid<Row>($('grid'), gridOptions);

/** An edit in a draft's cell is not written anywhere: it becomes an action waiting for confirmation. */
async function stageDraftEdit(row: Row, field: 'dueDate' | 'reference', value: unknown): Promise<void> {
  try {
    await api('POST', '/api/actions', { kind: 'UPDATE_DRAFT', invoiceId: row.id, payload: { [field]: value ?? '' } });
    toast('Change staged. Confirm it in the queue to update the draft at PayPal.');
  } catch (e) {
    fail(e);
  }
  await refresh(); // the cell shows PayPal's value again until the change is confirmed
}

// ---------------------------------------------------------------- header, figures, toolbar

function renderViews(): void {
  $('views').replaceChildren(...VIEWS.map((v) => {
    const b = h('button', null, v.label, [h('span', null, String(state.rows.filter(v.test).length))]);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.view === v.id));
    b.addEventListener('click', () => {
      state.view = v.id;
      grid.onFilterChanged();
      renderViews();
    });
    return b;
  }));
}

function sums(rows: Row[], pick: (r: Row) => number): [string, number][] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0) + pick(r));
  return [...by.entries()].map(([c, v]): [string, number] => [c, round2(v)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

function figure(label: string, totals: [string, number][], sub: string, cls = ''): HTMLElement {
  const value = h('div', 'value');
  if (totals.length) value.append(h('small', null, totals[0][0]), amount.format(totals[0][1]));
  else value.textContent = '0.00';
  const others = totals.slice(1).map(([c, v]) => `+ ${money(v, c)}`).join(' ');
  return h('div', `figure ${cls}`, null, [h('div', 'label', label), value, h('div', 'sub', [others, sub].filter(Boolean).join(' · '))]);
}

function renderFigures(): void {
  const open = state.rows.filter((r) => isOpen(r.status));
  const overdue = open.filter((r) => (r.daysOverdue ?? 0) > 0);
  const risky = open.filter((r) => r.riskLevel === 'high' || r.riskLevel === 'critical');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const queue = h('div', 'figure consent', null, [
    h('div', 'label', 'Awaiting your confirmation'),
    h('div', 'value', String(state.actions.length)),
    h('div', 'sub', state.actions.length ? 'Prepared, not sent' : 'Nothing is waiting'),
  ]);
  $('figures').replaceChildren(
    figure('Open receivables', sums(open, (r) => r.due), plural(open.length, 'invoice')),
    figure('Overdue', sums(overdue, (r) => r.due), plural(overdue.length, 'invoice'), overdue.length ? 'alert' : ''),
    figure('High or critical risk', sums(risky, (r) => r.due), plural(risky.length, 'invoice')),
    queue,
  );
}

function renderAskLabel(): void {
  const n = grid.getSelectedRows().length;
  $('ask').textContent = n ? `Ask the agent (${n} selected)` : 'Ask the agent (all open)';
}

async function askAgent(ids?: string[]): Promise<void> {
  const chosen = ids ?? grid.getSelectedRows().map((r) => r.id);
  const target = chosen.length ? chosen : state.rows.filter((r) => isOpen(r.status)).map((r) => r.id);
  if (!target.length) return toast('There is no open invoice to assess.');
  const ask = $<HTMLButtonElement>('ask');
  ask.disabled = true;
  try {
    const perRow = Object.fromEntries([...tones].filter(([, t]) => t !== 'auto'));
    const res = await api<{ results: { actionId: string | null }[] }>('POST', '/api/agent/propose', {
      invoiceIds: target, tone: $<HTMLSelectElement>('tone').value, tones: perRow,
    });
    const held = res.results.filter((r) => r.actionId).length;
    const waits = res.results.length - held;
    toast(`${held} proposal${held === 1 ? '' : 's'} waiting for your confirmation${waits ? `, ${waits} advised to wait` : ''}. Nothing has been sent.`);
    await refresh();
  } catch (e) {
    fail(e);
  } finally {
    ask.disabled = false;
  }
}

// ---------------------------------------------------------------- confirmation queue

function summaryLines(a: Action): [string, string][] {
  const p = a.payload;
  const m = (x: any) => (x ? money(Number(x.value), x.currency_code) : '');
  if (a.kind === 'OFFER_PLAN') return [['Part payments', `enabled, minimum ${m(p.minimumAmount)}`]];
  if (a.kind === 'RECORD_PAYMENT') return [['Amount', m(p.amount)], ['Method', String(p.method)], ['Date', String(p.paymentDate)]];
  if (a.kind === 'UPDATE_DRAFT') {
    return ([['Due date', p.dueDate], ['Reference', p.reference]] as [string, unknown][])
      .filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v) || '(empty)']);
  }
  if (a.kind === 'CREATE_DRAFT') {
    const d = p.draft ?? {};
    const item = d.items?.[0];
    const to = d.primary_recipients?.[0]?.billing_info ?? {};
    return [
      ['Customer', [to.business_name, to.email_address].filter(Boolean).join(', ')],
      ['Line', String(item?.name ?? '')],
      ['Amount', m(item?.unit_amount)],
      ['Due', String(d.detail?.payment_term?.due_date ?? '')],
    ];
  }
  if (a.kind === 'DELETE_DRAFT') return [['Effect', 'The draft is removed at PayPal']];
  return [];
}

function actionCard(a: Action): HTMLElement {
  const card = h('article', 'card');
  card.dataset.kind = a.kind;
  card.append(
    h('header', null, null, [
      h('span', 'kind', KIND_LABEL[a.kind] ?? a.kind),
      h('span', a.origin === 'agent' ? 'origin agent' : 'origin', a.origin === 'agent' ? 'Agent proposal' : 'Your request'),
    ]),
    h('p', 'who', [a.invoiceNumber, a.customer].filter(Boolean).join(' · ') || 'New invoice'),
  );
  if (a.rationale) card.append(h('p', 'why', a.rationale));
  for (const w of a.warnings) card.append(h('p', 'warn', w));

  let subject: HTMLInputElement | null = null;
  let note: HTMLTextAreaElement | null = null;
  if (MESSAGE_KINDS.includes(a.kind)) {
    subject = h('input');
    subject.value = String(a.payload.subject ?? '');
    note = h('textarea');
    note.rows = 8;
    note.value = String(a.payload.note ?? '');
    card.append(h('label', null, 'Subject', [subject]), h('label', null, 'Message to the customer', [note]));
    card.append(h('p', 'hint', a.kind === 'SEND'
      ? 'Checked on the PayPal sandbox: PayPal emails the invoice with its own subject and shows the invoice note, not this text.'
      : 'Checked on the PayPal sandbox: PayPal sends its own standard reminder and does not include this text. Use the link below to send it yourself.'));
    if (a.kind === 'REMIND' || a.kind === 'OFFER_PLAN') {
      // A way for the reviewed wording to reach the customer whatever PayPal does with it.
      const email = state.rows.find((r) => r.id === a.invoiceId)?.email ?? '';
      const to = /^[^\s@?&]+@[^\s@?&]+$/.test(email) ? email : '';
      const mail = h('a', 'mailto', 'Send this text from my own mail app');
      const [s, n] = [subject, note];
      const link = () => { mail.href = `mailto:${to}?subject=${encodeURIComponent(s.value)}&body=${encodeURIComponent(n.value)}`; };
      link();
      s.addEventListener('input', link);
      n.addEventListener('input', link);
      card.append(mail);
    }
  }
  const lines = summaryLines(a);
  if (lines.length) card.append(h('dl', null, null, lines.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  card.append(h('p', 'calls', 'On confirmation, sent to PayPal:', a.calls.map((c) => h('code', null, c))));

  const confirm = h('button', 'primary confirm', 'Confirm and send to PayPal');
  confirm.type = 'button';
  const discard = h('button', 'discard', 'Discard');
  discard.type = 'button';
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      let digest = a.digest;
      // If the text was edited, the edit is saved first, so the digest confirmed is the digest of
      // exactly what is on screen.
      if (subject && note && (subject.value !== a.payload.subject || note.value !== a.payload.note)) {
        const revised = await api<{ action: Action }>('PATCH', `/api/actions/${a.id}`, { payload: { subject: subject.value, note: note.value } });
        digest = revised.action.digest;
      }
      await api('POST', `/api/actions/${a.id}/confirm`, { confirm: true, digest });
      toast(`${KIND_LABEL[a.kind] ?? a.kind}: done at PayPal and journaled.`);
    } catch (e) {
      fail(e);
    }
    await refresh();
  });
  discard.addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/actions/${a.id}`);
      toast('Discarded. Nothing was sent.');
    } catch (e) {
      fail(e);
    }
    await refresh();
  });
  card.append(h('footer', null, null, [confirm, discard]));
  return card;
}

function renderQueue(): void {
  const count = $('queue-count');
  count.textContent = String(state.actions.length);
  count.className = state.actions.length ? 'count' : 'count zero';
  $('queue').replaceChildren(...(state.actions.length
    ? state.actions.map(actionCard)
    : [h('p', 'empty', 'Nothing is waiting. Ask the agent, or start an action from an invoice: it will stop here until you confirm it.')]));
}

// ---------------------------------------------------------------- invoice detail

async function prepare(kind: string, row: Row, payload: Record<string, unknown> = {}): Promise<void> {
  try {
    await api('POST', '/api/actions', { kind, invoiceId: row.id, payload });
    toast('Prepared. Review it in the queue; nothing has been sent.');
  } catch (e) {
    fail(e);
  }
  await refresh();
}

function button(label: string, onClick: () => void, cls = '', test = ''): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  if (test) b.dataset.test = test;
  b.addEventListener('click', onClick);
  return b;
}

function paymentForm(r: Row): HTMLElement {
  const form = h('form');
  const amountInput = h('input');
  amountInput.value = r.due.toFixed(2);
  amountInput.inputMode = 'decimal';
  const method = h('select', null, null, METHODS.map((m) => h('option', null, m)));
  const date = h('input');
  date.type = 'date';
  date.value = state.today;
  const submit = h('button', 'primary', 'Prepare payment record');
  form.append(
    h('label', null, `Amount (${r.currency})`, [amountInput]), h('label', null, 'Method', [method]),
    h('label', null, 'Received on', [date]), submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    state.paying = false;
    void prepare('RECORD_PAYMENT', r, {
      method: method.value, paymentDate: date.value, amount: { currency_code: r.currency, value: amountInput.value.trim() },
    });
  });
  return form;
}

function renderDetail(): void {
  const r = state.rows.find((x) => x.id === state.selectedId);
  const box = $('detail');
  if (!r) {
    box.replaceChildren(h('p', 'empty', 'Click a row to see why it is ranked where it is and what can be done about it.'));
    return;
  }
  const cell = (label: string, value: string) => h('div', null, null, [h('span', null, label), h('b', null, value)]);
  const out = h('div', 'detail', null, [
    h('h3', null, `${r.number} · ${r.customer}`),
    h('p', 'sub', [r.email, r.display, r.dueDate ? `due ${r.dueDate}` : ''].filter(Boolean).join(' · ')),
    h('div', 'amounts', null, [cell('Billed', money(r.total, r.currency)), cell('Paid', money(r.paid, r.currency)), cell('Open', money(r.due, r.currency))]),
  ]);
  if (r.riskScore !== null) {
    out.append(
      h('h4', null, `Risk ${r.riskScore}/100, ${r.riskLevel}`),
      h('ul', null, null, r.riskReasons.map((x) => h('li', null, x))),
      h('h4', null, r.nextStepSource === 'agent' ? 'Agent proposal' : 'Suggested by the rules'),
      h('p', null, `${r.nextStep ? STEP_LABEL[r.nextStep] : ''}. ${r.nextStepWhy}`),
    );
  }
  const buttons = h('div', 'buttons');
  if (isOpen(r.status)) {
    buttons.append(
      button('Ask the agent', () => void askAgent([r.id]), 'primary', 'detail-ask'),
      button('Record a payment', () => { state.paying = !state.paying; renderDetail(); }),
      button('Cancel invoice', () => void prepare('CANCEL', r), 'danger'),
    );
  } else if (r.status === 'DRAFT') {
    buttons.append(
      button('Send to customer', () => void prepare('SEND', r), 'primary', 'detail-send'),
      button('Delete draft', () => void prepare('DELETE_DRAFT', r), 'danger'),
    );
    out.append(h('p', 'sub', 'Double-click the due date or the reference in the grid to edit this draft.'));
  }
  if (buttons.childElementCount) out.append(buttons);
  if (state.paying && isOpen(r.status)) out.append(paymentForm(r));
  box.replaceChildren(out);
}

// ---------------------------------------------------------------- journal

function entryText(e: Entry): string {
  const what = e.kind ? KIND_LABEL[e.kind] ?? e.kind : '';
  const parts = [what, e.invoiceNumber ?? ''].filter(Boolean).join(' · ');
  if (e.origin === 'demo-seed') return `${parts} (sample history)`;
  if (e.type === 'failed') return `${parts}: ${e.detail?.error ?? 'failed'}`;
  if (e.type === 'discarded' || e.type === 'stale') return `${parts}${e.detail?.reason ? `: ${e.detail.reason}` : ''}`;
  return parts;
}

function renderJournal(): void {
  const chain = $('chain');
  chain.textContent = state.chain.ok
    ? `hash chain intact, ${state.chain.entries} entries`
    : `chain broken at entry ${state.chain.brokenAt}`;
  chain.className = state.chain.ok ? 'chain' : 'chain broken';
  $('journal').replaceChildren(...state.entries.slice(-60).reverse().map((e) => {
    const when = h('time', null, e.at.slice(0, 10) === state.today ? e.at.slice(11, 19) : e.at.slice(0, 10));
    when.dateTime = e.at;
    return h('li', null, null, [when, h('span', `type ${e.type}`, e.type), h('span', null, entryText(e))]);
  }));
}

// ---------------------------------------------------------------- load

async function refresh(): Promise<void> {
  try {
    const [inv, act, jr] = await Promise.all([
      api<{ today: string; rows: Row[] }>('GET', '/api/invoices'),
      api<{ actions: Action[] }>('GET', '/api/actions'),
      api<{ chain: typeof state.chain; entries: Entry[] }>('GET', '/api/journal'),
    ]);
    state.rows = inv.rows;
    state.today = inv.today;
    state.actions = act.actions;
    state.entries = jr.entries;
    state.chain = jr.chain;
    grid.setGridOption('rowData', state.rows);
    grid.refreshCells({ force: true });
    renderViews();
    renderFigures();
    renderAskLabel();
    renderQueue();
    renderDetail();
    renderJournal();
    document.body.dataset.ready = String(state.rows.length);
  } catch (e) {
    fail(e);
  }
}

async function start(): Promise<void> {
  try {
    const info = await api<{ paypal: string; mock: boolean; model: string; today: string }>('GET', '/api/state');
    const item = (k: string, v: string) => h('div', null, null, [h('dt', null, k), h('dd', null, v)]);
    $('env').replaceChildren(
      item('PayPal', info.mock ? 'local mock (demo data)' : info.paypal.replace(/^https?:\/\//, '')),
      item('Agent', info.model),
      item('Today', info.today),
    );
  } catch (e) {
    fail(e);
  }
  $('ask').addEventListener('click', () => void askAgent());
  $('csv').addEventListener('click', () => grid.exportDataAsCsv({ fileName: 'ledgerline.csv', skipPinnedBottom: true }));
  $<HTMLInputElement>('search').addEventListener('input', (e) => grid.setGridOption('quickFilterText', (e.target as HTMLInputElement).value));

  const dialog = $<HTMLDialogElement>('new-dialog');
  const form = $<HTMLFormElement>('new-form');
  $('new').addEventListener('click', () => dialog.showModal());
  $('new-cancel').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/actions', { kind: 'CREATE_DRAFT', form: Object.fromEntries(new FormData(form)) });
      dialog.close();
      form.reset();
      toast('Draft prepared. Confirm it in the queue to create it at PayPal.');
    } catch (err) {
      fail(err);
    }
    await refresh();
  });
  await refresh();
}

void start();
