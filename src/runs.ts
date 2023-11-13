import { OpenAPIHono } from '@hono/zod-openapi'
import createHttpError from 'http-errors'

import * as routes from './generated/oai-routes'
import * as config from './lib/config'
import * as utils from './lib/utils'
import { createThread } from './lib/create-thread'
import { prisma } from './lib/db'
import { queue } from './lib/queue'

const app: OpenAPIHono = new OpenAPIHono()

app.openapi(routes.listRuns, async (c) => {
  const { thread_id } = c.req.valid('param')
  const query = c.req.valid('query')
  console.log('listRuns', { thread_id, query })

  const params = utils.getPrismaFindManyParams(query)
  const res = await prisma.run.findMany(params)!

  // TODO: figure out why the types aren't working here
  return c.jsonT(utils.getPaginatedObject(res, params) as any)
})

app.openapi(routes.createThreadAndRun, async (c) => {
  const body = c.req.valid('json')
  console.log('createThreadAndRun', { body })

  await prisma.assistant.findUniqueOrThrow({
    where: {
      id: body.assistant_id
    }
  })

  const { thread: threadData, ...data } = utils.convertOAIToPrisma(body)
  const { thread } = await createThread(threadData)

  const run = await prisma.run.create({
    data: {
      ...utils.convertOAIToPrisma(data),
      thread_id: thread.id,
      status: 'queued' as const
    }
  })

  // Kick off async task
  await queue.add(
    config.queue.threadRunJobName,
    { runId: run.id },
    {
      jobId: run.id
    }
  )

  return c.jsonT(utils.convertPrismaToOAI(run))
})

app.openapi(routes.createRun, async (c) => {
  const { thread_id } = c.req.valid('param')
  const body = c.req.valid('json')
  console.log('createRun', { thread_id, body })

  // Ensure the assistant exists
  await prisma.assistant.findUniqueOrThrow({
    where: { id: body.assistant_id }
  })

  // Ensure the thread exists
  await prisma.thread.findUniqueOrThrow({
    where: { id: thread_id }
  })

  const run = await prisma.run.create({
    data: {
      ...utils.convertOAIToPrisma(body),
      thread_id,
      status: 'queued' as const
    }
  })

  // Kick off async task
  await queue.add(
    config.queue.threadRunJobName,
    { runId: run.id },
    {
      jobId: run.id
    }
  )

  return c.jsonT(utils.convertPrismaToOAI(run))
})

app.openapi(routes.getRun, async (c) => {
  const { thread_id, run_id } = c.req.valid('param')
  console.log('getRun', { thread_id, run_id })

  const run = await prisma.run.findUniqueOrThrow({
    where: {
      id: run_id,
      thread_id
    }
  })
  if (!run) return c.notFound() as any

  return c.jsonT(utils.convertPrismaToOAI(run))
})

app.openapi(routes.modifyRun, async (c) => {
  const { thread_id, run_id } = c.req.valid('param')
  const body = c.req.valid('json')
  console.log('modifyRun', { thread_id, run_id, body })

  const run = await prisma.run.update({
    where: {
      id: run_id,
      thread_id
    },
    data: utils.convertOAIToPrisma(body)
  })
  if (!run) return c.notFound() as any

  return c.jsonT(utils.convertPrismaToOAI(run))
})

app.openapi(routes.submitToolOuputsToRun, async (c) => {
  const { thread_id, run_id } = c.req.valid('param')
  const body = c.req.valid('json')
  console.log('submitToolOuputsToRun', { thread_id, run_id, body })

  const run = await prisma.run.findUniqueOrThrow({
    where: {
      id: run_id,
      thread_id
    }
  })
  if (!run) return c.notFound() as any

  const runStep = await prisma.runStep.findUniqueOrThrow({
    // @ts-expect-error this shouldn't be complaining
    where: {
      run_id,
      type: 'tool_calls' as const
    }
  })
  if (!runStep) return c.notFound() as any

  // TODO: validate body.tool_outputs against run.tools

  switch (run.status) {
    case 'cancelled':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'cancelling':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'completed':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'expired':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'failed':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'in_progress':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'queued':
      throw createHttpError(
        400,
        `Run status is "${run.status}", cannot submit tool outputs`
      )

    case 'requires_action': {
      const toolCalls = runStep.step_details?.tool_calls
      if (!toolCalls) throw createHttpError(500, 'Invalid tool call')

      for (const toolOutput of body.tool_outputs) {
        const toolCall = toolCalls.find(
          (toolCall) => toolCall.id === toolOutput.tool_call_id!
        )
        if (!toolCall) throw createHttpError(400, 'Invalid tool call')

        switch (toolCall.type) {
          case 'code_interpreter':
            // TODO
            // toolCall.code_interpreter?.outputs
            throw createHttpError(
              400,
              'Invalid third-party code_interpreter tool calls are not supported at this time'
            )

          case 'function':
            toolCall.function!.output = toolOutput.output!
            break

          case 'retrieval':
            // TODO
            throw createHttpError(
              400,
              'Invalid third-party retrieval tool calls are not supported at this time'
            )

          default:
            throw createHttpError(500, 'Invalid tool call type')
        }
      }

      runStep.status = 'completed'

      const { id, object, created_at, ...runStepUpdate } = runStep as any
      await prisma.runStep.update({
        where: { id: runStep.id },
        data: runStepUpdate
      })

      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'queued' }
      })

      break
    }

    default:
      throw createHttpError(500, 'Invalid tool call type')
  }

  return c.jsonT({ run_id, thread_id })
})

app.openapi(routes.cancelRun, async (c) => {
  const { thread_id, run_id } = c.req.valid('param')
  console.log('cancelRun', { thread_id, run_id })

  let run = await prisma.run.update({
    where: {
      id: run_id,
      thread_id
    },
    data: {
      status: 'cancelling',
      cancelled_at: new Date()
    }
  })
  if (!run) return c.notFound() as any

  const res = await queue.remove(run_id)
  if (res === 1) {
    run = await prisma.run.update({
      where: {
        id: run_id,
        thread_id
      },
      data: {
        status: 'cancelled'
      }
    })
    if (!run) return c.notFound() as any
  }

  // TODO: assistant_id and run_id may not exist here, but the output
  // types are too strict
  return c.jsonT(utils.convertPrismaToOAI(run))
})

export default app
