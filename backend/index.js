const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const axios = require("axios");

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

const DATA_TABLE = "ProjectManagerUserData";
const HISTORY_TABLE = process.env.HISTORY_TABLE || "ProjectManagerJobHistory";

async function logJobHistory(jobId, changeType, description) {
  try {
    const timestamp = new Date().toISOString();
    await docClient.send(new PutCommand({
      TableName: HISTORY_TABLE,
      Item: {
        JobId: jobId,
        Timestamp: timestamp,
        ChangeType: changeType,
        Description: description
      }
    }));
  } catch (err) {
    console.error("Failed to log job history:", err);
  }
}

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
      description: "Create a new job with a title, date, optional end date, and optional customer name.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            title: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
            endDate: { type: "string", description: "YYYY-MM-DD (optional end date to accommodate spans of time)" },
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
    const item = { 
      PK: userId, 
      SK: `JOB#${newJobId}`, 
      title: input.title, 
      date: input.date, 
      endDate: input.endDate || null, 
      customerName: input.customerName || null, 
      status: 'ESTIMATE', 
      createdAt: new Date().toISOString() 
    };
    await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
    await logJobHistory(newJobId, "CREATED", `Job "${input.title}" created via AI Assistant.`);
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

  if (name === "add_invoice_line_item") {
    const targetJobId = input.jobId || jobId;
    if (!targetJobId) return "Error: No job context provided.";
    
    const itemId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const item = {
      PK: userId,
      SK: `JOB#${targetJobId}#LINE#${itemId}`,
      description: input.description,
      type: input.type,
      cost: input.cost,
      quantity: input.quantity
    };
    await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
    await logJobHistory(targetJobId, "LINE_ITEM_ADDED", `Added item "${input.description}" (${input.quantity}x @ $${input.cost}) via AI Assistant.`);
    return `Added line item: "${input.description}" (${input.quantity}x @ $${input.cost}) to job ID: ${targetJobId}.`;
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
          if (!jobs[jobId]) jobs[jobId] = { id: jobId, lines: [], todos: [], visits: [] };
          if (parts.length === 2) Object.assign(jobs[jobId], item);
          else if (parts[2] === "LINE") jobs[jobId].lines.push(item);
          else if (parts[2] === "TODO") jobs[jobId].todos.push(item);
          else if (parts[2] === "VISIT") {
            if (!jobs[jobId].visits) jobs[jobId].visits = [];
            jobs[jobId].visits.push(item);
          }
        });
        return response(200, Object.values(jobs));
      }
      if (method === "POST") {
        const jobId = Date.now().toString();
        const item = { 
          PK: userId, 
          SK: `JOB#${jobId}`, 
          title: body.title, 
          date: body.date, 
          endDate: body.endDate || null, 
          customerName: body.customerName || null, 
          status: 'ESTIMATE', 
          createdAt: new Date().toISOString() 
        };
        await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
        await logJobHistory(jobId, "CREATED", `Job "${body.title}" created.`);
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
            
            const oldJob = await docClient.send(new GetCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}` }
            }));
            const oldStatus = oldJob.Item ? oldJob.Item.status : 'UNKNOWN';

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
            await logJobHistory(jobId, "STATUS_CHANGE", `Status updated from ${oldStatus} to ${status}`);
            return response(200, { message: `Status updated to ${status}` });
        }
        if (method === "PATCH") {
            const oldJob = await docClient.send(new GetCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}` }
            }));

            await docClient.send(new UpdateCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}` },
                UpdateExpression: "SET title = :t, #d = :d, endDate = :e, customerName = :c",
                ExpressionAttributeNames: { "#d": "date" },
                ExpressionAttributeValues: { ":t": body.title, ":d": body.date, ":e": body.endDate || null, ":c": body.customerName || null }
            }));

            const changes = [];
            if (oldJob.Item) {
                if (oldJob.Item.title !== body.title) changes.push(`title changed from "${oldJob.Item.title}" to "${body.title}"`);
                if (oldJob.Item.date !== body.date) changes.push(`date changed from "${oldJob.Item.date}" to "${body.date}"`);
                if (oldJob.Item.endDate !== body.endDate) changes.push(`end date changed from "${oldJob.Item.endDate || 'None'}" to "${body.endDate || 'None'}"`);
                const oldCust = oldJob.Item.customerName || "None";
                const newCust = body.customerName || "None";
                if (oldCust !== newCust) changes.push(`customer changed from "${oldCust}" to "${newCust}"`);
            }
            const changeDesc = changes.length > 0 ? `Job details updated: ${changes.join(", ")}` : "Job details saved.";
            await logJobHistory(jobId, "UPDATED", changeDesc);

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
            const oldTotal = (existingItems.Items || []).reduce((sum, l) => sum + (l.cost * l.quantity), 0);
            
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
            
            const newTotal = lines.reduce((sum, l) => sum + (l.cost * l.quantity), 0);
            await logJobHistory(jobId, "LINE_ITEMS_BULK_UPDATE", `Bulk updated line items. Total changed from $${oldTotal.toFixed(2)} to $${newTotal.toFixed(2)} (${lines.length} items total)`);
            return response(200, { message: "Bulk update successful" });
        }
        if (path.match(/\/jobs\/.*\/items\/.*$/) && method === "DELETE") {
            const itemId = path.split("/").pop();
            const existingItem = await docClient.send(new GetCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}` }
            }));
            const itemDesc = existingItem.Item ? existingItem.Item.description : 'Unknown Item';

            await docClient.send(new DeleteCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}` }
            }));
            await logJobHistory(jobId, "LINE_ITEM_DELETED", `Deleted item "${itemDesc}"`);
            return response(200, { message: "Item deleted" });
        }
        if (path.endsWith("/items") && method === "POST") {
            const itemId = Date.now().toString();
            await docClient.send(new PutCommand({
                TableName: DATA_TABLE,
                Item: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}`, ...body }
            }));
            await logJobHistory(jobId, "LINE_ITEM_ADDED", `Added item "${body.description}" (${body.quantity}x @ $${body.cost})`);
            return response(201, { id: itemId });
        }
        if (path.endsWith("/history") && method === "GET") {
            const result = await docClient.send(new QueryCommand({
                TableName: HISTORY_TABLE,
                KeyConditionExpression: "JobId = :jobId",
                ExpressionAttributeValues: { ":jobId": jobId },
                ScanIndexForward: false
            }));
            return response(200, result.Items || []);
        }
        if (path.endsWith("/visits") && method === "POST") {
            const visitId = Date.now().toString();
            const visitItem = {
                PK: userId,
                SK: `JOB#${jobId}#VISIT#${visitId}`,
                id: visitId,
                startDateTime: body.startDateTime,
                endDateTime: body.endDateTime,
                notes: body.notes || "",
                createdAt: new Date().toISOString()
            };
            await docClient.send(new PutCommand({
                TableName: DATA_TABLE,
                Item: visitItem
            }));
            await logJobHistory(jobId, "VISIT_ADDED", `Scheduled site visit: ${body.startDateTime} to ${body.endDateTime}.`);
            return response(201, { id: visitId });
        }
        if (path.match(/\/jobs\/.*\/visits\/.*$/) && method === "DELETE") {
            const visitId = path.split("/").pop();
            const existingVisit = await docClient.send(new GetCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}#VISIT#${visitId}` }
            }));
            const visitNotes = existingVisit.Item ? existingVisit.Item.notes : 'Site Visit';

            await docClient.send(new DeleteCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}#VISIT#${visitId}` }
            }));
            await logJobHistory(jobId, "VISIT_DELETED", `Deleted site visit: ${visitNotes}`);
            return response(200, { message: "Visit deleted" });
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
