import snowflake from "snowflake-sdk";

let connection: snowflake.Connection | null = null;

function createConnection(): snowflake.Connection {
  return snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT!,
    username: process.env.SNOWFLAKE_USERNAME!,
    password: process.env.SNOWFLAKE_PASSWORD!,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA,
    role: process.env.SNOWFLAKE_ROLE || undefined,
  });
}

async function getConnection(): Promise<snowflake.Connection> {
  if (connection && connection.isUp()) return connection;

  const conn = createConnection();
  await new Promise<void>((resolve, reject) => {
    conn.connect((err) => (err ? reject(err) : resolve()));
  });
  connection = conn;
  return conn;
}

export async function execute<T = Record<string, unknown>>(
  sqlText: string,
  binds: (string | number | null)[] = []
): Promise<T[]> {
  const conn = await getConnection();
  return new Promise<T[]>((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows ?? []) as T[]);
      },
    });
  });
}
