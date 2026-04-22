
import { StorableDataService } from './StorableDataService'
import { EvaluateBuffer, Explain, Ask,DescribeImage,RefineLanguage,GetPrompts } from '../../wailsjs/go/main/App'
import { JobID, AiListener, AiContext } from './AiJob'
import { Storable } from '../types'
import { stash, main } from '../../wailsjs/go/models'
import { getLocalISOString, applyFilingRecToMeta } from './fmUtils'


export interface JobState {
  isWaiting: boolean
  jobName: string
  startTime: number
}

export class AiService {
  private jobs = new Map<string, JobState>()
  private dataService: StorableDataService
  private onStateChange: () => void

  constructor(dataService: StorableDataService, onStateChange: () => void) {
    this.dataService = dataService
    this.onStateChange = onStateChange
  }

  getJob(job: JobID): JobState | undefined {
    return this.jobs.get(JSON.stringify(job))
  }

  private setJob(jobId: JobID, state: JobState | null) {
    if (state) this.jobs.set(JSON.stringify(jobId), state)
    else this.jobs.delete(JSON.stringify(jobId))
    this.onStateChange()
  }

  async explain(job: JobID, context: AiContext, listener: AiListener) {
    
    this.setJob(job, { isWaiting: true, jobName: 'Explain', startTime: Date.now() })

    try {
      const resp = await Explain(context.content, context.history, context.blockRef, context.imagePaths)
      this.setJob(job, null)
      listener.onComplete(job,resp.trim())
    } catch (err) {
      console.error('Explain error:', err)
      this.setJob(job, null)
      listener.onError(job,String(err))
    }
  }

  async ask(job: JobID, context: AiContext, question: string, listener: AiListener) {
    const { docId } = job
    this.setJob(job, { isWaiting: true, jobName: 'Ask', startTime: Date.now() })

    try {
      const resp = await Ask(context.content, context.history, question, context.blockRef, context.imagePaths)
      this.setJob(job, null)
      listener.onComplete(job,resp.trim())
    } catch (err) {
      console.error('Ask error:', err)
      this.setJob(job, null)
      listener.onError(job,String(err))
    }
  }

  async describeImage(job: JobID, path: string, listener: AiListener<stash.ImageDesc>) {
    this.setJob(job, { isWaiting: true, jobName: 'Describe Image', startTime: Date.now() })

    try {
      const resp : stash.ImageDesc = await DescribeImage(path)
      this.setJob(job, null)
      listener.onComplete(job,resp)
    } catch (err) {
      console.error('Describe Image error:', err)
      this.setJob(job, null)
      listener.onError(job,String(err))
    }
  }

  async refineLanguage(job: JobID,content: string, listener: AiListener<string>) {
    this.setJob(job, { isWaiting: true, jobName: 'Refine Language', startTime: Date.now() })

    try {
      const resp : string = await RefineLanguage(content)
      this.setJob(job, null)
      listener.onComplete(job,resp)
    } catch (err) {
      console.error('Refine Language error:', err)
      this.setJob(job, null)
      listener.onError(job,String(err))
    }
  }

  async evaluateDocument (docId: string, fileAfter: boolean, allowDiscard: boolean, listener: AiListener) {
    const job: JobID = { docId, blkId: '' }
    if (this.getJob(job)) return
    
    const jobState = { isWaiting: true, jobName: fileAfter ? 'Filing' : 'Metadata', startTime: Date.now() }
    this.setJob(job, jobState)
    this.dataService.setTransient(docId, { isWaitingAI: true, aiJobName: jobState.jobName })
      
    try {
      await this.dataService.save(job.docId).catch(console.error)
      var doc = this.dataService.get(job.docId)
      if(!doc) return
      const body = doc.body || ''
      const userIntent = doc.meta?.userIntent

      if (fileAfter && this.isContentEmpty(body) && userIntent !== 'keep') {
        await this.dataService.discard(job.docId)
        return
      }
      
      if(userIntent != 'trash') {
        const rec: stash.FilingRecommendation = await EvaluateBuffer(doc.path)
        const info = await this.dataService.getStoreInfo()
        const updatedMeta = applyFilingRecToMeta(doc.meta!, rec, info.cli)
        this.dataService.setMeta(job.docId, { ...updatedMeta, aiEval: 'complete', aiLastEvaluated: getLocalISOString() })
        doc = this.dataService.get(job.docId)
      } else if(userIntent === 'trash' && fileAfter && allowDiscard) {
        await this.dataService.discard(job.docId)
        return
      }

      
  
      if (fileAfter && doc != null) {
        if (doc instanceof main.NoteDTO) {
          await this.dataService.refile(job.docId)
        } else {
          await this.dataService.save(job.docId)
          await this.dataService.file(job.docId)
        }
      } else {
        await this.dataService.save(job.docId)
      }
      listener.onComplete(job,JSON.stringify(doc?.meta))
    } catch (err) {
      console.error('[stash:ai] background eval failed', err)
      listener.onError(job, String(err))
    } finally {
      this.setJob(job, null)
      this.dataService.setTransient(job.docId, { isWaitingAI: false })
    }
  }


  

  // ── High-Level Gestures ───────────────────────────────────────────────────

  /**
   * Trigger a filing evaluation. If allowDiscard is true, the AI can recommend 
   * trashing the document.
   */
  async smartFile(docId: string, allowDiscard: boolean = true) {
    return this.evaluateDocument(docId, true, allowDiscard, {
      onComplete: () => { /* listeners handle refresh */ },
      onError: (err) => console.error(`[AiService] Smart File failed for ${docId}:`, err)
    })
  }

  /**
   * Trigger a metadata-only evaluation (no filing).
   */
  async smartMetadata(docId: string) {
    return this.evaluateDocument(docId, false, false, {
      onComplete: () => { /* listeners handle refresh */ },
      onError: (err) => console.error(`[AiService] Smart Metadata failed for ${docId}:`, err)
    })
  }

  /**
   * Mark as Keep and then trigger a filing evaluation (discarding disallowed).
   */
  async keepAndFile(docId: string) {
    this.dataService.setIntent(docId, 'keep')
    return this.evaluateDocument(docId, true, false, {
      onComplete: () => { /* listeners handle refresh */ },
      onError: (err) => console.error(`[AiService] Keep and File failed for ${docId}:`, err)
    })
  }

  private isContentEmpty(html: string) {
    if (!html) return true
    const stripped = html.replace(/<[^>]*>/g, '').trim()
    return stripped === ''
  }

  getPendingCount() {
    return this.jobs.size
  }
}  
    

