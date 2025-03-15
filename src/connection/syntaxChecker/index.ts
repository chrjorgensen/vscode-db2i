import IBMi from "@halcyontech/vscode-ibmi-types/api/IBMi";
import { ComponentIdentification, ComponentState, IBMiComponent } from "@halcyontech/vscode-ibmi-types/components/component";
import { posix } from "path";
import { getValidatorSource, VALIDATOR_NAME, WRAPPER_NAME } from "./checker";
import { JobManager } from "../../config";
import { getInstance } from "../../base";

interface SqlCheckError {
  CURSTMTLENGTH: number;
  ERRORFIRSTCOLUMNNUMBER: number;
  ERRORFIRSTRECORDNUMBER: number;
  ERRORLASTCOLUMNNUMBER: number;
  ERRORLASTRECORDNUMBER: number;
  ERRORREPLACEMENTTEXT: string;
  ERRORSQLMESSAGEID: string;
  ERRORSQLSTATE: string;
  ERRORSYNTAXCOLUMNNUMBER: number;
  ERRORSYNTAXRECORDNUMBER: number;
  MESSAGEFILELIBRARY: string;
  MESSAGEFILENAME: string;
  MESSAGETEXT: string;
  NUMBEROFSTATEMENTSBACK: number;
}

type SqlErrorType = "error"|"warning"|"none";

const ERROR_STATE_MAP: {[state: string]: SqlErrorType} = {
  '00': 'none',
  '01': 'warning',
}

export interface SqlSyntaxError {
  type: SqlErrorType;
  sqlid: string;
  sqlstate: string;
  text: string;
  offset: number;
}

export class SQLStatementChecker implements IBMiComponent {
  static ID = "SQLStatementChecker";
  private readonly functionName = VALIDATOR_NAME;
  private readonly currentVersion = 5;

  private library = "";

  static get(): SQLStatementChecker|undefined {
    return getInstance()?.getConnection()?.getComponent<SQLStatementChecker>(SQLStatementChecker.ID);
  }

  reset() {
    this.library = "";
  }

  getIdentification(): ComponentIdentification {
    return { name: SQLStatementChecker.ID, version: this.currentVersion };
  }

  static async getVersionOf(connection: IBMi, schema: string, name: string) {
    const [result] = await connection.runSQL(`select cast(LONG_COMMENT as VarChar(200)) LONG_COMMENT from qsys2.sysroutines where routine_schema = '${schema}' and routine_name = '${name}'`);
    if (result?.LONG_COMMENT) {
      const comment = String(result.LONG_COMMENT);
      const dash = comment.indexOf('-');
      if (dash > -1) {
        return Number(comment.substring(0, dash).trim());
      }
    }

    return -1;
  }

  async getRemoteState(connection: IBMi) {
    this.library = connection.config?.tempLibrary.toUpperCase() || "ILEDITOR";

    const wrapperVersion = await SQLStatementChecker.getVersionOf(connection, this.library, WRAPPER_NAME);
    if (wrapperVersion < this.currentVersion) {
      return `NeedsUpdate`;
    }

    const installedVersion = await SQLStatementChecker.getVersionOf(connection, this.library, this.functionName);
    if (installedVersion < this.currentVersion) {
      return `NeedsUpdate`;
    }

    return `Installed`;
  }

  update(connection: IBMi): ComponentState | Promise<ComponentState> {
    return connection.withTempDirectory(async tempDir => {
      const tempSourcePath = posix.join(tempDir, `sqlchecker.sql`);
      await connection.content.writeStreamfileRaw(tempSourcePath, Buffer.from(this.getSource(), "utf-8"));
      const result = await connection.runCommand({
        command: `RUNSQLSTM SRCSTMF('${tempSourcePath}') COMMIT(*NONE) NAMING(*SYS)`,
        noLibList: true
      });

      if (result.code) {
        return `Error`;
      } else {
        return `Installed`;
      }
    });
  }

  private getSource() {
    return getValidatorSource(this.library, this.currentVersion);
  }

  async call(statement: string): Promise<SqlSyntaxError|undefined> {
    const currentJob = JobManager.getSelection();
    if (currentJob) {
      const result = await currentJob.job.execute<SqlCheckError>(`select * from table(${this.library}.${this.functionName}(?)) x`, {parameters: [statement]});
      
      if (!result.success || result.data.length === 0) return;

      const sqlError = result.data[0];
      return niceError(sqlError);
    }

    return undefined;
  }

  async checkMultipleStatements(statements: string[]): Promise<SqlSyntaxError[]|undefined> {
    const checks = statements.map(stmt => `select * from table(${this.library}.${this.functionName}(?)) x`).join(` union all `);
    const currentJob = JobManager.getSelection();

    if (currentJob) {
      const stmt = currentJob.job.query<SqlCheckError>(checks, {parameters: statements});
      const result = await stmt.execute(statements.length);
      stmt.close();
    
      if (!result.success || result.data.length === 0) return [];

      return result.data.map(sqlError => niceError(sqlError));
    }

    return undefined;
  }
}

function niceError(sqlError: SqlCheckError): SqlSyntaxError {
  const replaceTokens = splitReplaceText(sqlError.ERRORREPLACEMENTTEXT);

  let text = sqlError.MESSAGETEXT || `Unknown error message ${sqlError.ERRORSQLMESSAGEID ? `(${sqlError.ERRORSQLMESSAGEID})` : `(No message ID)`}`;
  replaceTokens.forEach((token, index) => {
    text = text.replace(`&${index+1}`, token);
  });

  const sqlState = sqlError.ERRORSQLSTATE.substring(0, 2);
  let errorType: SqlErrorType = (sqlState in ERROR_STATE_MAP ? ERROR_STATE_MAP[sqlState] : `error`);

  return {
    type: errorType,
    sqlid: sqlError.ERRORSQLMESSAGEID,
    sqlstate: sqlError.ERRORSQLSTATE,
    text,
    offset: sqlError.ERRORSYNTAXCOLUMNNUMBER,
  };
}

function splitReplaceText(input: string) {
    const firstGoodChar = input.split('').findIndex(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126);

    let replacements: string[] = [];    
    let inReplacement = false;
    let currentReplacement = ``;

    for (let i = firstGoodChar; i < input.length; i++) {
      const isGoodChar = input.charCodeAt(i) >= 32 && input.charCodeAt(i) <= 126;

      if (isGoodChar) {
        inReplacement = true;

        if (inReplacement) {
          currentReplacement += input[i];
        }
      } else {
        if (inReplacement) {
          replacements.push(currentReplacement);
          currentReplacement = ``;
        }
        
        inReplacement = false;
      }
    }

    if (currentReplacement) {
      replacements.push(currentReplacement);
    }

    return replacements;
  }