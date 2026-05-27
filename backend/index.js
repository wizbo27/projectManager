const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const axios = require("axios");

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

const DATA_TABLE = "ProjectManagerUserData";

// Tool definitions
const tools = [
  {
    toolSpec: {
      name: "get_labor_costs",
      description: "Get average labor pricing for a specific trade or job type.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            trade: { type: "string", description: "The construction trade (e.g., carpenter, electrician)." },
            location: { type: "string", description: "City and State." }
          },
          required: ["trade"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "search_lowes_materials",
      description: "Search for construction materials and prices at Lowe's.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            query: { type: "string", description: "The material to search for (e.g., 2x4x8 treated lumber)." }
          },
          required: ["query"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "create_job",
      description: "Create a new job with a title, date, and optional customer name.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            title: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
            customerName: { type: "string" }
          },
          required: ["title", "date"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "query_job_details",
      description: "Retrieve details about a specific job, including todos and invoice line items.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "The ID of the job to query." }
          },
          required: ["jobId"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "add_invoice_line_item",
      description: "Add a line item to a job's estimate/invoice.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            jobId: { type: "string" },
            description: { type: "string" },
            type: { type: "string", enum: ["labor", "material"] },
            cost: { type: "number" },
            quantity: { type: "number" }
          },
          required: ["jobId", "description", "type", "cost", "quantity"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "create_customer",
      description: "Create a new customer record.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" }
          },
          required: ["name"]
        }
      }
    }
  }
];

async function getSetting(userId, key) {
  const result = await docClient.send(new GetCommand({
    TableName: DATA_TABLE,
    Key: { PK: userId, SK: `SETTING#${key}` }
  }));
  return result.Item ? result.Item.value : null;
}

async function handleToolUse(userId, toolUse, jobId) {
  const name = toolUse.name;
  const input = toolUse.input;
  
  // Force jobId context
  input.jobId = input.jobId || jobId;
  console.log(`Tool: ${name}, Input: ${JSON.stringify(input)}`);

  if (name === "create_job") {
    const newJobId = Date.now().toString();
    const item = { PK: userId, SK: `JOB#${newJobId}`, title: input.title, date: input.date, customerName: input.customerName || null, status: 'ESTIMATE', createdAt: new Date().toISOString() };
    await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
    return `Job "${input.title}" created. ID: ${newJobId}`;
  }

  if (name === "query_job_details") {
    const targetJobId = input.jobId || jobId;
    if (!targetJobId) return "Error: No job context provided.";
    
    const result = await docClient.send(new QueryCommand({
      TableName: DATA_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": userId, ":sk": `JOB#${targetJobId}` }
    }));
    
    return JSON.stringify(result.Items);
  }

  if (name === "create_customer") {
    const cid = Date.now().toString();
    await docClient.send(new PutCommand({
      TableName: DATA_TABLE,
      Item: { PK: userId, SK: `CUSTOMER#${cid}`, name: input.name, email: input.email, phone: input.phone }
    }));
    return `Customer "${input.name}" created.`;
  }

  if (name === "get_labor_costs") {
    const rates = { "carpenter": 45, "electrician": 85, "plumber": 90, "painter": 35, "handyman": 50 };
    const trade = input.trade.toLowerCase();
    const rate = rates[trade] || 60;
    return `Average rate for ${trade}: $${rate}/hr.`;
  }

  if (name === "search_lowes_materials") {
    return `Found: ${input.query}. Price: $29.99 (Simulated)`;
  }

  return "Tool not implemented.";
}

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event));
  
  const method = event.requestContext.http.method;
  let path = event.requestContext.http.path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  
  if (method === "OPTIONS") {
      return {
          statusCode: 200,
          headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PATCH",
              "Access-Control-Allow-Headers": "Content-Type,Authorization"
          },
          body: JSON.stringify({ message: "OK" })
      };
  }

  const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (!userId) return response(401, { message: "Unauthorized" });

  try {
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
    
    // Customers
    if (path === "/customers") {
        if (method === "GET") {
            const query = event.queryStringParameters?.q;
            const scanParams = {
                TableName: DATA_TABLE,
                FilterExpression: "begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":sk": "CUSTOMER#" }
            };

            if (query) {
                scanParams.FilterExpression += " AND contains(#n, :q)";
                scanParams.ExpressionAttributeNames = { "#n": "name" };
                scanParams.ExpressionAttributeValues[":q"] = query;
            }

            const result = await docClient.send(new QueryCommand({
                TableName: DATA_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":pk": userId, ":sk": "CUSTOMER#" }
            }));
            
            // If searching, we might need a Scan if we can't use Query effectively on non-key attributes, 
            // but since we are already filtering by PK (userId) and SK (CUSTOMER#), 
            // we can just filter the result of the Query in memory or use a FilterExpression in the Query.
            
            let items = result.Items || [];
            if (query) {
                items = items.filter(item => item.name && item.name.toLowerCase().includes(query.toLowerCase()));
            }
            return response(200, items);
        }

        if (method === "POST" || method === "PATCH") {
            const cid = body.id || Date.now().toString();
            await docClient.send(new PutCommand({
                TableName: DATA_TABLE,
                Item: { PK: userId, SK: `CUSTOMER#${cid}`, ...body, id: cid }
            }));
            return response(200, { id: cid });
        }
        if (method === "DELETE") {
            const cid = event.queryStringParameters?.id;
            const customer = await docClient.send(new GetCommand({TableName: DATA_TABLE, Key: {PK: userId, SK: `CUSTOMER#${cid}`}}));
            const jobs = await docClient.send(new QueryCommand({
                TableName: DATA_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":pk": userId, ":sk": "JOB#" }
            }));
            const hasJobs = jobs.Items.some(j => j.customerName === customer.Item?.name);
            if (hasJobs) return response(400, { message: "Cannot delete: Customer has associated jobs." });
            
            await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `CUSTOMER#${cid}` } }));
            return response(200, { message: "Customer deleted" });
        }
    }

    // Jobs
    if (path === "/jobs") {
      if (method === "GET") {
        const result = await docClient.send(new QueryCommand({
          TableName: DATA_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": userId, ":sk": "JOB#" }
        }));
        const jobs = {};
        result.Items.forEach(item => {
          const parts = item.SK.split("#");
          const jobId = parts[1];
          if (!jobs[jobId]) jobs[jobId] = { id: jobId, lines: [], todos: [] };
          if (parts.length === 2) Object.assign(jobs[jobId], item);
          else if (parts[2] === "LINE") jobs[jobId].lines.push(item);
          else if (parts[2] === "TODO") jobs[jobId].todos.push(item);
        });
        return response(200, Object.values(jobs));
      }
      if (method === "POST") {
        const jobId = Date.now().toString();
        const item = { PK: userId, SK: `JOB#${jobId}`, title: body.title, date: body.date, customerName: body.customerName || null, status: 'ESTIMATE', createdAt: new Date().toISOString() };
        await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
        return response(201, { id: jobId });
      }
    }
    
    if (path.startsWith("/jobs/")) {
        const jobId = path.split("/")[2];
        if (path.endsWith("/status") && method === "PATCH") {
            const { status } = body;
            const validStatuses = ['ESTIMATE', 'APPROVED', 'IN PROGRESS', 'INVOICED', 'PAID'];
            if (!validStatuses.includes(status)) {
                return response(400, { message: "Invalid status value" });
            }
            
            const updateExpression = status === 'APPROVED' 
                ? "SET #s = :s, approvalDate = :ad" 
                : "SET #s = :s";
            const expressionAttributeValues = status === 'APPROVED'
                ? { ":s": status, ":ad": new Date().toISOString() }
                : { ":s": status };

            await docClient.send(new UpdateCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}` },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: expressionAttributeValues
            }));
            return response(200, { message: `Status updated to ${status}` });
        }
        if (method === "PATCH") {
            await docClient.send(new UpdateCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}` },
                UpdateExpression: "SET title = :t, #d = :d, customerName = :c",
                ExpressionAttributeNames: { "#d": "date" },
                ExpressionAttributeValues: { ":t": body.title, ":d": body.date, ":c": body.customerName || null }
            }));
            return response(200, { message: "Job updated" });
        }
        if (path.endsWith("/items/bulk") && method === "POST") {
            const lines = body.lines || [];
            // 1. Delete existing line items for this job
            const existingItems = await docClient.send(new QueryCommand({
                TableName: DATA_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":pk": userId, ":sk": `JOB#${jobId}#LINE` }
            }));
            
            for (const item of (existingItems.Items || [])) {
                await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: item.SK } }));
            }
            
            // 2. Add new updated lines
            for (const line of lines) {
                const itemId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                await docClient.send(new PutCommand({
                    TableName: DATA_TABLE,
                    Item: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}`, ...line }
                }));
            }
            return response(200, { message: "Bulk update successful" });
        }
        if (path.match(/\/jobs\/.*\/items\/.*$/) && method === "DELETE") {
            const itemId = path.split("/").pop();
            await docClient.send(new DeleteCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}` }
            }));
            return response(200, { message: "Item deleted" });
        }
        if (path.endsWith("/items") && method === "POST") {
            const itemId = Date.now().toString();
            await docClient.send(new PutCommand({
                TableName: DATA_TABLE,
                Item: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}`, ...body }
            }));
            return response(201, { id: itemId });
        }
    }

    // Chat
    if (path === "/chat" && method === "POST") {
      let messages = body.history || [{ role: "user", content: [{ text: body.message }] }];
      if (body.history) {
        messages.push({ role: "user", content: [{ text: body.message }] });
      }
      let system = [{text:"You are a handyman project management helper. Use 'add_invoice_line_item' tool to add costs to a job estimate."}];
      if(body.jobId){
        system.push({text:"You are currently in the context of job ID: "+body.jobId+". Always pass this jobId to tool calls."});
      }
      let finalMessage = "";

      for (let i = 0; i < 3; i++) {
        const command = new ConverseCommand({
          modelId: "amazon.nova-lite-v1:0",
          messages: messages,
          system:system,
          toolConfig: { tools }
        });
        const result = await bedrockClient.send(command);
        const outputMessage = result.output.message;
        messages.push(outputMessage);

        if (result.stopReason === "tool_use") {
          const toolResults = [];
          for (const content of outputMessage.content) {
            if (content.toolUse) {
              const toolOutput = await handleToolUse(userId, content.toolUse, body.jobId);
              toolResults.push({
                toolResult: { toolUseId: content.toolUse.toolUseId, content: [{ text: toolOutput }] }
              });
            }
          }
          messages.push({ role: "user", content: toolResults });
        } else {
          finalMessage = outputMessage.content.find(c => c.text)?.text || "Done.";
          break;
        }
      }
      return response(200, { message: finalMessage, history: messages });
    }

    // Settings
    if (path === "/settings") {
        if (method === "GET") {
            const waveToken = await getSetting(userId, "WAVE_TOKEN");
            const businessId = await getSetting(userId, "WAVE_BUSINESS_ID");
            return response(200, { waveToken, businessId });
        }
        if (method === "POST") {
            await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#WAVE_TOKEN", value: body.waveToken } }));
            await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#WAVE_BUSINESS_ID", value: body.businessId } }));
            return response(200, { message: "Saved" });
        }
    }

    return response(404, { message: "Not Found" });
  } catch (err) {
    console.error(err);
    return response(200, { message: "Error: " + err.message });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PATCH",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    },
    body: JSON.stringify(body)
  };
}
