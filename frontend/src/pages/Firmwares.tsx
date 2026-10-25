import type { Component } from 'solid-js';
import { createResource, createSignal, createMemo, Show, For } from 'solid-js';
import { Upload, Trash2, HardDrive, Package, Search, X } from 'lucide-solid';
import { api, type Firmware } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import SortableHeader from '../components/SortableHeader';
import { sortRows, type SortDirection } from '../lib/sorting';
import { createPersistedSignal } from '../lib/storage';
import { formatDateTime } from '../lib/dateTime';

const Firmwares: Component = () => {
  const { isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const [firmwares, { refetch }] = createResource(() => api.getFirmwares());
  const [uploading, setUploading] = createSignal(false);
  const [validation, setValidation] = createSignal<{ file?: string; version?: string }>({});
  const [columnFilters, setColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.firmwares');
  const [sortState, setSortState] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'created_at', direction: 'desc' });
  const handleSort = (column: string) => setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  const { columns, isVisible, toggle } = useColumnVisibility('firmwares', [
    { id: 'filename', label: 'Filename', visible: true },
    { id: 'version', label: 'Version', visible: true },
    { id: 'manufacturer', label: 'Manufacturer', visible: true },
    { id: 'file_size', label: 'Size', visible: true },
    { id: 'created_at', label: 'Uploaded', visible: true },
  ]);
  const [fwPage, setFwPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('firmwares', 15);
  const handlePageSizeChange = (size: number) => { changePageSize(size); setFwPage(0); };

  const getFilterValue = (fw: Firmware, colId: string): string => {
    switch (colId) {
      case 'filename': return fw.filename || '';
      case 'version': return fw.version || '';
      case 'manufacturer': return fw.manufacturer || '';
      case 'file_size': return String(fw.file_size || '');
      case 'created_at': return fw.created_at || '';
      default: return '';
    }
  };

  const filteredFirmwares = createMemo(() => {
    let all = firmwares() || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      all = all.filter(fw =>
        fw.filename?.toLowerCase().includes(query) ||
        fw.version?.toLowerCase().includes(query) ||
        fw.manufacturer?.toLowerCase().includes(query) ||
        fw.product_class?.toLowerCase().includes(query) ||
        fw.description?.toLowerCase().includes(query)
      );
    }
    return sortRows(applyColumnFilters(all, columnFilters(), getFilterValue), sortState().column, sortState().direction, (fw, column) => column === 'file_size' ? fw.file_size : getFilterValue(fw, column));
  });
  const pagedFirmwares = createMemo(() => {
    const all = filteredFirmwares();
    const start = fwPage() * pageSize();
    return all.slice(start, start + pageSize());
  });
  const fwTotalPages = createMemo(() => Math.ceil(filteredFirmwares().length / pageSize()));

  const [formData, setFormData] = createSignal({
    version: '',
    manufacturer: '',
    product_class: '',
    description: '',
  });

  let fileInputRef: HTMLInputElement | undefined;

  const handleUpload = async () => {
    const file = fileInputRef?.files?.[0];
    const errors: { file?: string; version?: string } = {};
    if (!file) {
      errors.file = 'Select a firmware artifact before starting the upload.';
    }

    const data = formData();
    if (!data.version.trim()) {
      errors.version = 'Enter the vendor firmware version exactly as it should appear in deployment records.';
    }
    setValidation(errors);
    if (Object.keys(errors).length > 0 || !file) return;

    setUploading(true);
    try {
      await api.uploadFirmware(file, data.version, data.manufacturer, data.product_class, data.description);
      notify({ tone: 'success', title: 'Firmware artifact uploaded', message: `${file.name} is available for controlled CPE deployment.` });
      await refetch();
      setFormData({ version: '', manufacturer: '', product_class: '', description: '' });
      setValidation({});
      if (fileInputRef) fileInputRef.value = '';
    } catch (err) {
      notify({ tone: 'error', title: 'Firmware upload failed', message: 'The artifact was not added to the library. Correct the reported issue and retry.', detail: (err as Error).message, persistent: true });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: number, filename: string) => {
    if (!await confirm({ title: `Delete ${filename}?`, description: 'The artifact will no longer be available for new firmware tasks. Existing task records remain in the audit history.', confirmLabel: 'Delete firmware', tone: 'danger' })) return;
    try {
      await api.deleteFirmware(id);
      notify({ tone: 'success', title: 'Firmware artifact deleted', message: filename });
      await refetch();
    } catch (err) {
      notify({ tone: 'error', title: 'Could not delete firmware', message: 'The artifact remains available. Retry after checking active deployment references.', detail: (err as Error).message, persistent: true });
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const formatDate = (dateStr: string) => formatDateTime(dateStr);

  return (
    <div class="space-y-6">
      <PageHeader title="Firmware library" description="Validated artifacts ready for controlled CPE deployment." />

      <Show when={isFullAccess()}><div class="card p-5">
        <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
          <Upload size={14} />
          Upload firmware artifact
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label for="firmware-file" class="block text-xs text-muted mb-1.5">Firmware file</label>
            <input
              id="firmware-file"
              ref={fileInputRef}
              type="file"
              accept=".bin,.img,.tar,.gz,.zip"
              class="w-full px-3 py-2 bg-surface border border-default rounded-[3px] text-sm text-secondary file:mr-3 file:py-1 file:px-3 file:rounded-[2px] file:border-0 file:bg-sky-600 file:text-white file:text-xs file:cursor-pointer"
              aria-invalid={Boolean(validation().file)}
              aria-describedby={validation().file ? 'firmware-file-error' : undefined}
            />
            <Show when={validation().file}><p id="firmware-file-error" class="field-error">{validation().file}</p></Show>
          </div>
          <div>
            <label for="firmware-version" class="block text-xs text-muted mb-1.5">Firmware version <span aria-hidden="true">*</span></label>
            <input
              id="firmware-version"
              type="text"
              value={formData().version}
              onInput={(e) => setFormData({ ...formData(), version: e.currentTarget.value })}
              placeholder="e.g. V5R019C00S100"
              class="input"
              required
              aria-invalid={Boolean(validation().version)}
              aria-describedby={validation().version ? 'firmware-version-error' : undefined}
            />
            <Show when={validation().version}><p id="firmware-version-error" class="field-error">{validation().version}</p></Show>
          </div>
          <div>
            <label for="firmware-manufacturer" class="block text-xs text-muted mb-1.5">Manufacturer</label>
            <input
              id="firmware-manufacturer"
              type="text"
              value={formData().manufacturer}
              onInput={(e) => setFormData({ ...formData(), manufacturer: e.currentTarget.value })}
              placeholder="e.g. Huawei"
              class="input"
            />
          </div>
          <div>
            <label for="firmware-product-class" class="block text-xs text-muted mb-1.5">Product class</label>
            <input
              id="firmware-product-class"
              type="text"
              value={formData().product_class}
              onInput={(e) => setFormData({ ...formData(), product_class: e.currentTarget.value })}
              placeholder="e.g. HG8245W5"
              class="input"
            />
          </div>
          <div class="md:col-span-2">
            <label for="firmware-description" class="block text-xs text-muted mb-1.5">Deployment notes</label>
            <textarea
              id="firmware-description"
              value={formData().description}
              onInput={(e) => setFormData({ ...formData(), description: e.currentTarget.value })}
              placeholder="Optional compatibility or rollout notes"
              rows={2}
              class="input resize-none"
            />
          </div>
        </div>
        <button
          onClick={handleUpload}
          disabled={uploading()}
          class="btn btn-primary mt-4"
        >
          <Upload size={14} />
          {uploading() ? 'Uploading artifact…' : 'Upload firmware'}
        </button>
      </div></Show>

      <div class="card overflow-hidden">
        <div class="p-5 border-b border-subtle flex items-center justify-between">
          <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
            <Package size={14} />
            Firmware Library ({firmwares()?.length || 0})
          </h2>
          <div class="relative">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input type="text" value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)} placeholder="Search firmware…" class="input pl-9! w-56 text-sm" />
            <Show when={searchQuery()}>
              <button onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
            </Show>
          </div>
        </div>
        <Show when={firmwares.loading}><div class="p-4 space-y-3" aria-label="Loading firmware library"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div></Show>
        <Show when={firmwares.error}><ResourceError title="Firmware library is unavailable" description="ACS could not retrieve the artifact inventory. No firmware data was changed." onRetry={() => refetch()} /></Show>
        <Show when={!firmwares.loading && !firmwares.error && (firmwares()?.length || 0) > 0} fallback={!firmwares.loading && !firmwares.error ?
          <EmptyState icon={<HardDrive size={22} />} title="No firmware artifacts are stored" description={isFullAccess() ? 'Upload a vendor firmware file with an exact version and compatibility scope before creating a deployment task.' : 'A full-access operator must upload and validate an artifact before it can be selected for deployment.'} /> : undefined
        }>
          <div class="overflow-x-auto table-scroll"><table class="data-table w-full min-w-[720px]">
            <thead>
              <tr class="border-b border-subtle">
                <Show when={isVisible('filename')}>
                  <th class="px-4 py-3 text-left text-xs font-medium text-muted">
                    <div class="flex items-center gap-1.5"><SortableHeader column="filename" label="Filename" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                      <ColumnFilter columnId="filename" label="Filename" active={columnFilters()['filename'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['filename'] = s; else delete n['filename']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <Show when={isVisible('version')}>
                  <th class="px-4 py-3 text-left text-xs font-medium text-muted">
                    <div class="flex items-center gap-1.5"><SortableHeader column="version" label="Version" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                      <ColumnFilter columnId="version" label="Version" active={columnFilters()['version'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['version'] = s; else delete n['version']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <Show when={isVisible('manufacturer')}>
                  <th class="px-4 py-3 text-left text-xs font-medium text-muted">
                    <div class="flex items-center gap-1.5"><SortableHeader column="manufacturer" label="Manufacturer" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                      <ColumnFilter columnId="manufacturer" label="Manufacturer" active={columnFilters()['manufacturer'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['manufacturer'] = s; else delete n['manufacturer']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <Show when={isVisible('file_size')}>
                  <th class="px-4 py-3 text-left text-xs font-medium text-muted">
                    <div class="flex items-center gap-1.5"><SortableHeader column="file_size" label="Size" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                      <ColumnFilter columnId="file_size" label="Size" active={columnFilters()['file_size'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['file_size'] = s; else delete n['file_size']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <Show when={isVisible('created_at')}>
                  <th class="px-4 py-3 text-left text-xs font-medium text-muted">
                    <div class="flex items-center gap-1.5"><SortableHeader column="created_at" label="Uploaded" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                      <ColumnFilter columnId="created_at" label="Uploaded" active={columnFilters()['created_at'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['created_at'] = s; else delete n['created_at']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <th class="px-4 py-3 text-left text-xs font-medium text-muted">Actions</th>
                <th class="px-2 py-3"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
              </tr>
            </thead>
            <tbody>
              <For each={pagedFirmwares()}>
                {(fw: Firmware) => (
                  <tr class="border-t border-subtle/50 hover:bg-elevated/30 transition-fast">
                    <Show when={isVisible('filename')}><td class="px-4 py-3 text-primary font-mono text-sm">{fw.filename}</td></Show>
                    <Show when={isVisible('version')}><td class="px-4 py-3 font-mono text-xs text-secondary">{fw.version}</td></Show>
                    <Show when={isVisible('manufacturer')}><td class="px-4 py-3 text-secondary text-sm">{fw.manufacturer || '-'}</td></Show>
                    <Show when={isVisible('file_size')}><td class="px-4 py-3 text-secondary text-sm">{formatSize(fw.file_size)}</td></Show>
                    <Show when={isVisible('created_at')}><td class="px-4 py-3 text-muted text-xs">{formatDate(fw.created_at)}</td></Show>
                    <td class="px-4 py-3">
                      <Show when={isFullAccess()}><button
                        onClick={() => handleDelete(fw.id, fw.filename)}
                        class="text-rose-400 hover:text-rose-300 text-sm flex items-center gap-1 transition-fast"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button></Show>
                    </td>
                    <td class="px-2 py-3"></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table></div>
          <div class="px-4 py-3">
            <Pagination page={fwPage()} totalPages={fwTotalPages()} totalItems={filteredFirmwares().length} pageSize={pageSize()} onPageChange={setFwPage} storageKey="firmwares" onPageSizeChange={handlePageSizeChange} />
          </div>
        </Show>
      </div>

      <p class="text-muted text-xs">
        To deploy an artifact, open a CPE record and create a controlled firmware download task.
      </p>
    </div>
  );
};

export default Firmwares;
