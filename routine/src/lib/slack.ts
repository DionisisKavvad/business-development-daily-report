import { WebClient } from '@slack/web-api';

/** Post the report link to the configured Slack channel. */
export async function postReportLink(params: {
  date: string;
  url: string;
  oneLiner: string;
  criticalCount: number;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN as string;
  const channel = process.env.SLACK_REPORT_CHANNEL as string;
  const client = new WebClient(token);

  const emoji = params.criticalCount > 0 ? '🔴' : '🟢';
  await client.chat.postMessage({
    channel,
    text: `${emoji} BD Daily Report — ${params.date}: ${params.oneLiner} → ${params.url}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *BD Daily Report — ${params.date}*\n${params.oneLiner}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open report' },
            url: params.url,
          },
        ],
      },
    ],
  });
}
