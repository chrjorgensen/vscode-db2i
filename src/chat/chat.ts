import * as vscode from "vscode";
import { JobManager } from "../config";
import Statement from "../database/statement";
import { GptMessage, chatRequest } from "./send";
import Configuration from "../configuration";

const CHAT_ID = `vscode-db2i.chat`;

interface IDB2ChatResult extends vscode.ChatResult {
  metadata: {
    command: string;
  };
}

const getDefaultSchema = (): string => {
  const currentJob = JobManager.getSelection();
  return currentJob && currentJob.job.options.libraries[0] ? currentJob.job.options.libraries[0] : `QGPL`;
}

type TableRefs = { [key: string]: TableColumn[] };

async function findPossibleTables(schema: string, words: string[]) {
  words = words.map(word => word.replace(/[.,\/#!?$%\^&\*;:{}=\-_`~()]/g,""))

  // Add extra words for words with S at the end, to ignore possible plurals
  words
    .forEach(item => {
      if (item.endsWith(`s`)) {
        words.push(item.slice(0, -1));
      }
    })

  const validWords = words
    .filter(item => item.length > 2 && !item.includes(`'`))
    .map(item => `'${Statement.delimName(item, true)}'`);

  const objectFindStatement = [
    `SELECT `,
    `  column.TABLE_NAME,`,
    `  column.COLUMN_NAME,`,
    `  key.CONSTRAINT_NAME,`,
    `  column.DATA_TYPE, `,
    `  column.CHARACTER_MAXIMUM_LENGTH,`,
    `  column.NUMERIC_SCALE, `,
    `  column.NUMERIC_PRECISION,`,
    `  column.IS_NULLABLE, `,
    // `  column.HAS_DEFAULT, `,
    // `  column.COLUMN_DEFAULT, `,
    `  column.COLUMN_TEXT, `,
    `  column.IS_IDENTITY`,
    `FROM QSYS2.SYSCOLUMNS2 as column`,
    `LEFT JOIN QSYS2.syskeycst as key`,
    `  on `,
    `    column.table_schema = key.table_schema and`,
    `    column.table_name = key.table_name and`,
    `    column.column_name = key.column_name`,
    `WHERE column.TABLE_SCHEMA = '${schema}'`,
    ...[words.length > 0 ? `AND column.TABLE_NAME in (${validWords.join(`, `)})` : ``],
    `ORDER BY column.ORDINAL_POSITION`,
  ].join(` `);

  // TODO
  const result: TableColumn[] = await JobManager.runSQL(objectFindStatement);

  const tables: TableRefs = {};

  for (const row of result) {
    if (!tables[row.TABLE_NAME]) {
      tables[row.TABLE_NAME] = [];
    }

    tables[row.TABLE_NAME].push(row);
  }

  return tables;
}

function refsToMarkdown(refs: TableRefs) {
  const condensedResult = Object.keys(refs).length > 5;

  let markdown: string[] = [];

  for (const tableName in refs) {
    if (tableName.startsWith(`SYS`)) continue;

    markdown.push(`# ${tableName}`, ``);

    if (condensedResult) {
      markdown.push(`| Column | Type | Text |`);
      markdown.push(`| - | - | - |`);
    } else {
      markdown.push(`| Column | Type | Nullable | Identity | Text | Constraint |`);
      markdown.push(`| - | - | - | - | - | - |`);
    }
    for (const column of refs[tableName]) {
      if (condensedResult) {
        markdown.push(`| ${column.COLUMN_NAME} | ${column.DATA_TYPE} | ${column.COLUMN_TEXT} |`);
      } else {
        markdown.push(`| ${column.COLUMN_NAME} | ${column.DATA_TYPE} | ${column.IS_NULLABLE} | ${column.IS_IDENTITY} | ${column.COLUMN_TEXT} | ${column.CONSTRAINT_NAME} |`);
      }
    }

    markdown.push(``);
  }

  return markdown.join(`\n`);
}

export function activateChat(context: vscode.ExtensionContext) {

  // chatHandler deals with the input from the chat windows,
  // and uses streamModelResponse to send the response back to the chat window
  const chatHandler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<IDB2ChatResult> => {
    let messages: GptMessage[];

    const usingSchema = getDefaultSchema();

    request.variables

    switch (request.command) {
      case `activity`:
        stream.progress(`Grabbing Information about IBM i system`);
        const data = await processUserMessage();
        console.log(`summarize the following data in a readable paragraph: ${data}`)
        messages = [
          new vscode.LanguageModelChatSystemMessage(
            `You are a an IBM i savant speciallizing in database features in Db2 for i. Please provide a summary of the current IBM i system state based on the developer requirement.`
          ),
          new vscode.LanguageModelChatSystemMessage(
            `Here is the current IBM i state: ${data}`
          ),
          new vscode.LanguageModelChatUserMessage(request.prompt),
        ];

        await streamModelResponse(messages, stream, token);

        return { metadata: { command: "activity" } };
        
      default:
        context
        stream.progress(`Getting information from ${Statement.prettyName(usingSchema)}...`);
        let refs = await findPossibleTables(usingSchema, request.prompt.split(` `));

        messages = [new vscode.LanguageModelChatSystemMessage(
          `You are a an IBM i savant speciallizing in database features in Db2 for i. Your job is to help developers write and debug their SQL along with offering SQL programming advice.`
        )];

        if (Object.keys(refs).length === 0) {
          stream.progress(`No references found. Doing bigger lookup...`);
          refs = await findPossibleTables(usingSchema, []);
        }

        if (Object.keys(refs).length > 0) {
          stream.progress(`Building response...`);
          messages.push(
            new vscode.LanguageModelChatSystemMessage(
              `Give the developer an SQL statement or information based on the prompt and following table references. Always include code examples where is makes sense. Do not make suggestions for reference you do not have.`
            ),
            new vscode.LanguageModelChatSystemMessage(
              `Here are the table references for current schema ${usingSchema}\n${refsToMarkdown(refs)}`
            ),
            new vscode.LanguageModelChatUserMessage(request.prompt),
          );

        } else {
          stream.progress(`No references found.`);
          messages.push(
            new vscode.LanguageModelChatSystemMessage(
              `Warn the developer that their request is not clear or that no references were found. Provide a suggestion or ask for more information.`
            ),
            new vscode.LanguageModelChatSystemMessage(
              `The developers current schema is ${usingSchema}.`
            ),
          );
        }

        await streamModelResponse(messages, stream, token);

        return { metadata: { command: "build" } };
    }
  };

  const variableResolver = vscode.chat.registerChatVariableResolver(`coolness`, `Selected value`, 
    {
      resolve: async (name, context, token) => {
        const editor = vscode.window.activeTextEditor;
        return [{value: 'Hello world', level: vscode.ChatVariableLevel.Full}];
      }
    }
  );

  const chat = vscode.chat.createChatParticipant(CHAT_ID, chatHandler);
  chat.isSticky = true;
  chat.iconPath = new vscode.ThemeIcon(`database`);

  context.subscriptions.push(chat, variableResolver);
}


async function processUserMessage(): Promise<string> {
  const sqlStatment = `SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS(RESET_STATISTICS=>'YES',DETAILED_INFO=>'ALL')) X`;
  const result = await JobManager.runSQL(sqlStatment, undefined);
  return JSON.stringify(result);
}

async function streamModelResponse(
  messages: GptMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) {
  try {
    const chosenModel = Configuration.get<string>(`vscode-db2i.ai.model`);

    const chatResponse = await chatRequest(
      chosenModel,
      messages,
      {},
      token
    );

    for await (const fragement of chatResponse.stream) {
      stream.markdown(fragement);
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      console.log(err.message, err.code, err.stack);
    } else {
      console.log(err);
    }
  }
}

export function deactivate() { }
