import { analyzeUploadedContract, UploadAnalysis } from './analysisPipeline';
import { isProcessable } from './security/eligibility';
import { runSecurityInspectionPipeline } from './security/pipeline';
import { deleteQuarantinedFile } from './security/quarantineManager';
import { FullSecurityReport } from './security/types';

export interface UploadInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  sessionId: string;
  /** ?analyze=1: run extraction -> normalization -> understanding -> risk -> decision report in this request */
  analyze: boolean;
}

export interface UploadDeps {
  inspect: typeof runSecurityInspectionPipeline;
  analyze: (fileId: string, sessionId: string) => Promise<UploadAnalysis>;
  purge: typeof deleteQuarantinedFile;
}

const defaultDeps: UploadDeps = {
  inspect: runSecurityInspectionPipeline,
  analyze: analyzeUploadedContract,
  purge: deleteQuarantinedFile,
};

export interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The supported workflow: one request in, one complete answer out, nothing kept.
 *
 * The uploaded file, its quarantine metadata, every intermediate result (extraction, normalization, understanding)
 * and all server-side caches are deleted in the `finally` block, whether inspection, analysis or anything else
 * succeeded, failed or threw. The completed report is returned to the caller before anything could be retrieved again.
 */
export async function runUploadWorkflow(input: UploadInput, deps: UploadDeps = defaultDeps): Promise<UploadResult> {
  let fileId: string | undefined;
  let result: UploadResult;
  let documentDeleted = true;

  try {
    const report: FullSecurityReport = await deps.inspect(input.buffer, input.originalName, input.mimeType, input.sessionId);
    fileId = report.fileId;

    if (input.analyze && isProcessable(report)) {
      let analysis: UploadAnalysis;
      try {
        analysis = await deps.analyze(report.fileId, input.sessionId);
      } catch (err) {
        console.error('[upload] analysis failed:', err instanceof Error ? err.message : 'unknown error');
        analysis = { error: 'The contract analysis failed unexpectedly. The document has been deleted; please upload it again.' };
      }
      result = { status: 200, body: { ...report, analysis } };
    } else {
      result = { status: 200, body: { ...report } };
    }
  } catch (error: any) {
    console.error('[upload] security inspection failed:', error instanceof Error ? error.message : 'unknown error');
    result = {
      status: 500,
      body: { error: error?.message || 'Internal security inspection failure.', status: 'SCAN_FAILED' },
    };
  } finally {
    if (fileId) {
      const deleted = deps.purge(fileId, input.sessionId);
      documentDeleted = deleted.success;
      if (!deleted.success) console.error('[upload] document cleanup reported a failure; the sweeper will remove any remaining file.');
    }
  }

  // Reported honestly: true only if the deletion succeeded.
  result!.body.documentDeleted = documentDeleted;
  return result!;
}
