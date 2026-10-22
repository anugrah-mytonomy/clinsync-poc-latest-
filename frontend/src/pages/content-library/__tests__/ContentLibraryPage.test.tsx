import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { renderWithProviders, screen, waitFor } from '@/testing/testUtils';

const API = 'http://api.test';
const uploads: { name: string; batchId?: string; replacesDocumentId?: string }[] = [];
let batchCount = 0;

// The uploader is mocked (the S3 side); check-duplicates and batches go through MSW like the real API.
vi.mock('@/utils/contentLibraryUploadApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/contentLibraryUploadApi')>();
  return {
    ...actual,
    ContentLibraryUploader: class {
      private readonly name: string;
      constructor(file: File, options: { batchId: string; replacesDocumentId?: string }) {
        this.name = file.name;
        uploads.push({ name: file.name, batchId: options.batchId, replacesDocumentId: options.replacesDocumentId });
      }
      start() {
        return Promise.resolve({ fileId: `id-${this.name}`, status: 'uploaded' });
      }
      cancel() {}
    },
  };
});

const renderPage = async () => {
  vi.stubEnv('VITE_SCAN_API_URL', API);
  vi.resetModules();
  const { default: ContentLibraryPage } = await import('@/pages/content-library/ContentLibraryPage');
  const { UploadQueueProvider } = await import('@/context/UploadQueueContext');
  server.use(
    http.post(`${API}/clinsync/uploads/check-duplicates`, () => HttpResponse.json({ matches: [] })),
    http.post(`${API}/clinsync/uploads/batches`, () => {
      batchCount += 1;
      return HttpResponse.json({ batchId: `00000000-0000-4000-8000-${String(batchCount).padStart(12, '0')}` });
    }),
    http.post(`${API}/api/v1/uploads/batches/:id/commit`, () =>
      HttpResponse.json({ added: 2, skipped: [], still_in_progress: 0, documents: ['d1', 'd2'] }),
    ),
    http.get(`${API}/api/v1/library/documents`, () => HttpResponse.json({ documents: [], total: 0 })),
  );
  const view = renderWithProviders(
    <UploadQueueProvider>
      <ContentLibraryPage />
    </UploadQueueProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: /add content/i }));
  await screen.findByText('Drag documents here or browse your system');
  return view;
};

// applyAccept: false — a dragged-in file is not filtered by the input's accept list the way the file picker is.
const drop = async (container: HTMLElement, names: string[]) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.setup({ applyAccept: false }).upload(
    input,
    names.map((name) => new File(['content'], name)),
  );
};

describe('ContentLibraryPage — one batchId per Upload click (D4)', () => {
  afterEach(() => {
    uploads.length = 0;
    vi.unstubAllEnvs();
  });

  it('starts every file of one click with the same batchId, and a new click with a new one', async () => {
    const { container } = await renderPage();
    const upload = () => screen.getByRole('button', { name: /^upload$/i });

    await drop(container, ['a.docx', 'b.docx']);
    await waitFor(() => expect(upload()).toBeEnabled());
    await userEvent.click(upload());
    await waitFor(() => expect(uploads).toHaveLength(2));
    await screen.findByText('2 uploaded · 0 failed');

    // Continue to Tagging → Tag Documents (both files listed) → Confirm & Continue commits and lands on the Library,
    // with no review panel; Add Content again starts a new Upload click.
    await userEvent.click(screen.getByRole('button', { name: /continue to tagging/i }));
    expect(await screen.findByText('Documents (2)')).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /confirm & continue/i }));
    await userEvent.click(await screen.findByRole('button', { name: /add content/i }));
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    await drop(container, ['c.docx']);
    await waitFor(() => expect(upload()).toBeEnabled());
    await userEvent.click(upload());
    await waitFor(() => expect(uploads).toHaveLength(3));

    const [a, b, c] = uploads;
    expect(a.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.batchId).toBe(a.batchId);
    expect(c.batchId).not.toBe(a.batchId);
  }, 15_000); // walks Add Content → Uploading → Tag Documents → Library → Add Content

  it('shows a type the server does not allow as not supported, without uploading it', async () => {
    const { container } = await renderPage();
    await drop(container, ['clip.mp4']);
    expect(await screen.findByText('Rejected — Unsupported file format (.mp4)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^upload$/i })).toBeDisabled();
    expect(screen.getByText('0 accepted · 0 duplicate · 1 rejected')).toBeInTheDocument();
  });

  it('groups same-name files at the top and enables Upload once the group is resolved', async () => {
    const { container } = await renderPage();
    await drop(container, ['Whipple.docx', 'whipple.DOCX', 'Other.docx']);
    expect(await screen.findByText('Duplicate Group')).toBeInTheDocument();
    expect(screen.getByText('1 accepted · 1 duplicate · 0 rejected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^upload$/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove whipple.DOCX' }));
    expect(screen.queryByText('Duplicate Group')).not.toBeInTheDocument();
    expect(screen.getByText('2 accepted · 0 duplicate · 0 rejected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^upload$/i })).toBeEnabled();
  });

  const libraryMatch = () =>
    server.use( // after renderPage, so it wins over the no-match handler there
      http.post(`${API}/clinsync/uploads/check-duplicates`, () =>
        HttpResponse.json({
          matches: [
            {
              fileName: 'whipple.docx',
              match: { fileId: 'doc-7', sizeBytes: 42, addedAt: '2026-09-01T00:00:00Z', version: 1,
                       specialties: ['Cardiology'], documentType: 'Patient Education Text' },
            },
          ],
        }),
      ),
    );

  it('asks Remove or Replace for a file already in the library, and Remove drops it from the upload', async () => {
    const { container } = await renderPage();
    libraryMatch();
    await drop(container, ['whipple.docx', 'Other.docx']);
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByText('Document 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('Cardiology')).toBeInTheDocument();
    expect(screen.getByText('Patient Education Text')).toBeInTheDocument();
    const finish = screen.getByRole('button', { name: 'Accept & Finish' });
    expect(finish).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: /remove new document/i }));
    await userEvent.click(finish);
    await waitFor(() => expect(uploads.map((u) => u.name)).toEqual(['Other.docx']));
  });

  it('Replace uploads the new copy naming the library document it replaces', async () => {
    const { container } = await renderPage();
    libraryMatch();
    await drop(container, ['whipple.docx']);
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await userEvent.click(await screen.findByRole('radio', { name: /replace existing document/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept & Finish' }));
    await waitFor(() => expect(uploads).toEqual([expect.objectContaining({ name: 'whipple.docx', replacesDocumentId: 'doc-7' })]));
  });

  it('a failed POST /batches leaves the queue on Add Content', async () => {
    const { container } = await renderPage();
    server.use(http.post(`${API}/clinsync/uploads/batches`, () => HttpResponse.json({ detail: 'Database down' }, { status: 503 })));
    await drop(container, ['a.docx']);
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^upload$/i })).toBeEnabled());
    expect(uploads).toEqual([]);
    expect(screen.getByText('1 accepted · 0 duplicate · 0 rejected')).toBeInTheDocument();
  });
});
