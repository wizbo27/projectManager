const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const axios = require("axios");

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({});

const DATA_TABLE = "ProjectManagerUserData";
const HISTORY_TABLE = process.env.HISTORY_TABLE || "ProjectManagerJobHistory";
const FILES_BUCKET = process.env.FILES_BUCKET;

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
      inputSchema: { json: { type: "object", properties: { trade: { type: "string" }, location: { type: "string" } }, required: ["trade"] } }
    }
  },
  {
    toolSpec: {
      name: "search_lowes_materials",
      description: "Search for construction materials and prices at Lowe's.",
      inputSchema: { json: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
    }
  },
  {
    toolSpec: {
      name: "create_job",
      description: "Create a new job.",
      inputSchema: { json: { type: "object", properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, endDate: { type: "string" }, customerName: { type: "string" }, paymentTerms: { type: "string" } }, required: ["title", "date"] } }
    }
  },
  {
    toolSpec: {
      name: "update_job_details",
      description: "Update existing job details.",
      inputSchema: { json: { type: "object", properties: { jobId: { type: "string" }, title: { type: "string" }, date: { type: "string" }, endDate: { type: "string" }, customerName: { type: "string" }, paymentTerms: { type: "string" } }, required: ["jobId"] } }
    }
  },
  {
    toolSpec: {
      name: "advance_job_status",
      description: "Move a job to its next logical status (ESTIMATE -> APPROVED -> IN PROGRESS -> INVOICED -> PAID).",
      inputSchema: { json: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } }
    }
  },
  {
    toolSpec: {
      name: "query_job_details",
      description: "Retrieve details about a job (lines, expenses, visits, etc).",
      inputSchema: { json: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } }
    }
  },
  {
    toolSpec: {
      name: "add_invoice_line_item",
      description: "Add a cost item to an estimate/invoice.",
      inputSchema: { json: { type: "object", properties: { jobId: { type: "string" }, description: { type: "string" }, type: { type: "string", enum: ["labor", "material"] }, cost: { type: "number" }, quantity: { type: "number" } }, required: ["jobId", "description", "type", "cost", "quantity"] } }
    }
  },
  {
    toolSpec: {
      name: "log_actual_expense",
      description: "Log a real expense incurred.",
      inputSchema: { json: { type: "object", properties: { jobId: { type: "string" }, description: { type: "string" }, cost: { type: "number" }, quantity: { type: "number" } }, required: ["jobId", "description", "cost", "quantity"] } }
    }
  },
  {
    toolSpec: {
      name: "schedule_site_visit",
      description: "Schedule a site visit for a job.",
      inputSchema: { json: { type: "object", properties: { jobId: { type: "string" }, startDateTime: { type: "string", description: "ISO 8601" }, endDateTime: { type: "string" }, notes: { type: "string" } }, required: ["jobId", "startDateTime", "endDateTime"] } }
    }
  },
  {
    toolSpec: {
      name: "create_customer",
      description: "Create a new customer record.",
      inputSchema: { json: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, address: { type: "string" } }, required: ["name"] } }
    }
  },
  {
    toolSpec: {
      name: "log_expense_from_receipt",
      description: "Extract expense details from a receipt image and log it to the job.",
      inputSchema: { 
        json: { 
          type: "object", 
          properties: { 
            jobId: { type: "string" }, 
            imageKey: { type: "string", description: "The S3 key of the receipt image uploaded to chat." } 
          }, 
          required: ["jobId", "imageKey"] 
        } 
      }
    }
  },
  {
    toolSpec: {
      name: "update_company_settings",
      description: "Update company name or invoice notes.",
      inputSchema: { json: { type: "object", properties: { companyName: { type: "string" }, invoiceNotes: { type: "string" } } } }
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
  const targetJobId = input.jobId || jobId;
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
      paymentTerms: input.paymentTerms || null,
      status: 'ESTIMATE', 
      createdAt: new Date().toISOString() 
    };
    await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
    await logJobHistory(newJobId, "CREATED", `Job "${input.title}" created via AI Assistant.`);
    return `Job "${input.title}" created. ID: ${newJobId}`;
  }

  if (name === "update_job_details") {
    if (!targetJobId) return "Error: No jobId provided.";
    const oldJob = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${targetJobId}` } }));
    if (!oldJob.Item) return "Error: Job not found.";

    const updates = [];
    if (input.title) updates.push(`title changed to "${input.title}"`);
    if (input.date) updates.push(`date changed to "${input.date}"`);
    if (input.endDate) updates.push(`end date changed to "${input.endDate}"`);
    if (input.customerName) updates.push(`customer changed to "${input.customerName}"`);
    if (input.paymentTerms) updates.push(`payment terms changed to "${input.paymentTerms}"`);

    await docClient.send(new UpdateCommand({
        TableName: DATA_TABLE,
        Key: { PK: userId, SK: `JOB#${targetJobId}` },
        UpdateExpression: "SET title = :t, #d = :d, endDate = :e, customerName = :c, paymentTerms = :p",
        ExpressionAttributeNames: { "#d": "date" },
        ExpressionAttributeValues: { 
            ":t": input.title || oldJob.Item.title, 
            ":d": input.date || oldJob.Item.date, 
            ":e": input.endDate || oldJob.Item.endDate || null, 
            ":c": input.customerName || oldJob.Item.customerName || null,
            ":p": input.paymentTerms || oldJob.Item.paymentTerms || null
        }
    }));
    await logJobHistory(targetJobId, "UPDATED", `Job updated via AI: ${updates.join(", ")}`);
    return `Job ${targetJobId} updated successfully.`;
  }

  if (name === "advance_job_status") {
    if (!targetJobId) return "Error: No jobId provided.";
    const job = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${targetJobId}` } }));
    if (!job.Item) return "Error: Job not found.";
    
    const statuses = ['ESTIMATE', 'APPROVED', 'IN PROGRESS', 'INVOICED', 'PAID'];
    const currentIndex = statuses.indexOf(job.Item.status);
    if (currentIndex === -1 || currentIndex === statuses.length - 1) return `Status "${job.Item.status}" cannot be advanced further.`;
    
    const nextStatus = statuses[currentIndex + 1];
    const updateExpression = nextStatus === 'APPROVED' ? "SET #s = :s, approvalDate = :ad" : "SET #s = :s";
    const attrValues = nextStatus === 'APPROVED' ? { ":s": nextStatus, ":ad": new Date().toISOString() } : { ":s": nextStatus };

    await docClient.send(new UpdateCommand({
        TableName: DATA_TABLE,
        Key: { PK: userId, SK: `JOB#${targetJobId}` },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: attrValues
    }));
    await logJobHistory(targetJobId, "STATUS_CHANGE", `Status advanced to ${nextStatus} via AI.`);
    return `Job status advanced to ${nextStatus}.`;
  }

  if (name === "query_job_details") {
    if (!targetJobId) return "Error: No job context provided.";
    const result = await docClient.send(new QueryCommand({
      TableName: DATA_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": userId, ":sk": `JOB#${targetJobId}` }
    }));
    return JSON.stringify(result.Items);
  }

  if (name === "add_invoice_line_item") {
    if (!targetJobId) return "Error: No job context provided.";
    const itemId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    await docClient.send(new PutCommand({
      TableName: DATA_TABLE,
      Item: { PK: userId, SK: `JOB#${targetJobId}#LINE#${itemId}`, description: input.description, type: input.type, cost: input.cost, quantity: input.quantity }
    }));
    await logJobHistory(targetJobId, "LINE_ITEM_ADDED", `Added ${input.type} "${input.description}" (${input.quantity}x @ $${input.cost}) via AI.`);
    return `Added line item to job ${targetJobId}.`;
  }

  if (name === "log_expense_from_receipt") {
    if (!targetJobId) return "Error: No jobId provided.";
    if (!input.imageKey) return "Error: No imageKey provided.";

    try {
        // 1. Fetch image from S3
        const getObj = await s3Client.send(new GetObjectCommand({
            Bucket: FILES_BUCKET,
            Key: input.imageKey
        }));
        const bodyContents = await getObj.Body.transformToByteArray();
        
        // 2. Call Bedrock (Nova Lite) to extract expense data
        const extractionPrompt = "Extract expense details from this receipt image. Return JSON: { \"description\": string, \"cost\": number, \"quantity\": number }. If quantity isn't clear, use 1. Only return the JSON.";
        const command = new ConverseCommand({
            modelId: "amazon.nova-lite-v1:0",
            messages: [{
                role: "user",
                content: [
                    { text: extractionPrompt },
                    { image: { format: input.imageKey.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg', source: { bytes: bodyContents } } }
                ]
            }]
        });
        const result = await bedrockClient.send(command);
        const text = result.output.message.content[0].text;
        const data = JSON.parse(text.match(/\{.*\}/s)[0]);

        // 3. Log expense
        const expenseId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        await docClient.send(new PutCommand({
            TableName: DATA_TABLE,
            Item: {
                PK: userId,
                SK: `JOB#${targetJobId}#EXPENSE#${expenseId}`,
                description: data.description,
                cost: data.cost,
                quantity: data.quantity,
                timestamp: new Date().toISOString(),
                receiptKey: input.imageKey
            }
        }));

        // 4. Archive file to job files list
        await docClient.send(new PutCommand({
            TableName: DATA_TABLE,
            Item: {
                PK: userId,
                SK: `JOB#${targetJobId}#FILE#${Date.now()}`,
                name: `Receipt_${data.description.replace(/\s+/g, '_')}.jpg`,
                key: input.imageKey,
                tag: 'Receipt',
                timestamp: new Date().toISOString()
            }
        }));

        await logJobHistory(targetJobId, "EXPENSE_LOGGED", `Processed receipt image: Logged "${data.description}" ($${data.cost} x ${data.quantity})`);
        return `Successfully processed receipt and logged expense: "${data.description}" for $${data.cost}.`;
    } catch (err) {
        console.error("Receipt processing error:", err);
        return "Error: Failed to process receipt image. " + err.message;
    }
  }

  if (name === "schedule_site_visit") {
    if (!targetJobId) return "Error: No job context provided.";
    const visitId = Date.now().toString();
    await docClient.send(new PutCommand({
      TableName: DATA_TABLE,
      Item: { PK: userId, SK: `JOB#${targetJobId}#VISIT#${visitId}`, id: visitId, startDateTime: input.startDateTime, endDateTime: input.endDateTime, notes: input.notes || "", createdAt: new Date().toISOString() }
    }));
    await logJobHistory(targetJobId, "VISIT_ADDED", `Scheduled visit via AI: ${input.startDateTime} to ${input.endDateTime}.`);
    return `Site visit scheduled for job ${targetJobId}.`;
  }

  if (name === "create_customer") {
    const cid = Date.now().toString();
    await docClient.send(new PutCommand({
      TableName: DATA_TABLE,
      Item: { PK: userId, SK: `CUSTOMER#${cid}`, name: input.name, email: input.email || null, phone: input.phone || null, address: input.address || null, id: cid }
    }));
    return `Customer "${input.name}" created successfully.`;
  }

  if (name === "update_company_settings") {
    if (input.companyName) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#COMPANY_NAME", value: input.companyName } }));
    if (input.invoiceNotes) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#INVOICE_NOTES", value: input.invoiceNotes } }));
    return "Company settings updated successfully.";
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
            const result = await docClient.send(new QueryCommand({
                TableName: DATA_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":pk": userId, ":sk": "CUSTOMER#" }
            }));
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
        for (const item of result.Items) {
          const parts = item.SK.split("#");
          const jobId = parts[1];
          if (!jobs[jobId]) jobs[jobId] = { id: jobId, lines: [], todos: [], visits: [], expenses: [], files: [] };
          if (parts.length === 2) Object.assign(jobs[jobId], item);
          else if (parts[2] === "LINE") jobs[jobId].lines.push(item);
          else if (parts[2] === "TODO") jobs[jobId].todos.push(item);
          else if (parts[2] === "EXPENSE") jobs[jobId].expenses.push(item);
          else if (parts[2] === "FILE") {
            if (item.key) {
              item.url = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: FILES_BUCKET,
                Key: item.key
              }), { expiresIn: 3600 });
            }
            jobs[jobId].files.push(item);
          }
          else if (parts[2] === "VISIT") {
            if (!jobs[jobId].visits) jobs[jobId].visits = [];
            jobs[jobId].visits.push(item);
          }
        }
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
          paymentTerms: body.paymentTerms || null,
          status: 'ESTIMATE', 
          createdAt: new Date().toISOString() 
        };
        await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: item }));
        await logJobHistory(jobId, "CREATED", `Job "${body.title}" created.`);
        return response(201, { id: jobId });
      }
    }
    
    if (path.startsWith("/jobs/")) {
        const pathParts = path.split("/");
        const jobId = pathParts[2];
        
        if (path.endsWith("/files/upload-url") && method === "GET") {
            const fileName = event.queryStringParameters?.fileName;
            const fileType = event.queryStringParameters?.fileType;
            const isBranding = event.queryStringParameters?.branding === "true";
            if (!fileName) return response(400, { message: "fileName is required" });
            
            const key = isBranding 
                ? `branding/${userId}/${Date.now()}_${fileName}`
                : `uploads/${userId}/${jobId}/${Date.now()}_${fileName}`;
                
            const uploadUrl = await getSignedUrl(s3Client, new PutObjectCommand({
                Bucket: FILES_BUCKET,
                Key: key,
                ContentType: fileType || 'application/octet-stream'
            }), { expiresIn: 300 });
            
            return response(200, { uploadUrl, key });
        }

        if (path.endsWith("/status") && method === "PATCH") {
            const { status } = body;
            const validStatuses = ['ESTIMATE', 'APPROVED', 'IN PROGRESS', 'INVOICED', 'PAID'];
            if (!validStatuses.includes(status)) return response(400, { message: "Invalid status value" });
            
            const oldJob = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${jobId}` } }));
            const oldStatus = oldJob.Item ? oldJob.Item.status : 'UNKNOWN';

            const updateExpression = status === 'APPROVED' ? "SET #s = :s, approvalDate = :ad" : "SET #s = :s";
            const expressionAttributeValues = status === 'APPROVED' ? { ":s": status, ":ad": new Date().toISOString() } : { ":s": status };

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
            const oldJob = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${jobId}` } }));
            await docClient.send(new UpdateCommand({
                TableName: DATA_TABLE,
                Key: { PK: userId, SK: `JOB#${jobId}` },
                UpdateExpression: "SET title = :t, #d = :d, endDate = :e, customerName = :c, paymentTerms = :p",
                ExpressionAttributeNames: { "#d": "date" },
                ExpressionAttributeValues: { ":t": body.title, ":d": body.date, ":e": body.endDate || null, ":c": body.customerName || null, ":p": body.paymentTerms || null }
            }));
            const changes = [];
            if (oldJob.Item) {
                if (oldJob.Item.title !== body.title) changes.push(`title changed from "${oldJob.Item.title}" to "${body.title}"`);
                if (oldJob.Item.date !== body.date) changes.push(`date changed from "${oldJob.Item.date}" to "${body.date}"`);
                if (oldJob.Item.endDate !== body.endDate) changes.push(`end date changed from "${oldJob.Item.endDate || 'None'}" to "${body.endDate || 'None'}"`);
                const oldCust = oldJob.Item.customerName || "None";
                const newCust = body.customerName || "None";
                if (oldCust !== newCust) changes.push(`customer changed from "${oldCust}" to "${newCust}"`);
                const oldTerms = oldJob.Item.paymentTerms || "None";
                const newTerms = body.paymentTerms || "None";
                if (oldTerms !== newTerms) changes.push(`payment terms changed from "${oldTerms}" to "${newTerms}"`);
            }
            const changeDesc = changes.length > 0 ? `Job details updated: ${changes.join(", ")}` : "Job details saved.";
            await logJobHistory(jobId, "UPDATED", changeDesc);
            return response(200, { message: "Job updated" });
        }
        if (path.endsWith("/items/bulk") && method === "POST") {
            const lines = body.lines || [];
            const existingItems = await docClient.send(new QueryCommand({
                TableName: DATA_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":pk": userId, ":sk": `JOB#${jobId}#LINE` }
            }));
            const oldTotal = (existingItems.Items || []).reduce((sum, l) => sum + (l.cost * l.quantity), 0);
            for (const item of (existingItems.Items || [])) {
                await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: item.SK } }));
            }
            for (const line of lines) {
                const itemId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}`, ...line } }));
            }
            const newTotal = lines.reduce((sum, l) => sum + (l.cost * l.quantity), 0);
            await logJobHistory(jobId, "LINE_ITEMS_BULK_UPDATE", `Bulk updated line items. Total changed from $${oldTotal.toFixed(2)} to $${newTotal.toFixed(2)} (${lines.length} items total)`);
            return response(200, { message: "Bulk update successful" });
        }
        if (path.endsWith("/expenses/bulk") && method === "POST") {
            const expenses = body.expenses || [];
            const existingExpenses = await docClient.send(new QueryCommand({
                TableName: DATA_TABLE,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: { ":pk": userId, ":sk": `JOB#${jobId}#EXPENSE` }
            }));
            for (const item of (existingExpenses.Items || [])) {
                await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: item.SK } }));
            }
            for (const exp of expenses) {
                const expenseId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                await docClient.send(new PutCommand({
                    TableName: DATA_TABLE,
                    Item: { PK: userId, SK: `JOB#${jobId}#EXPENSE#${expenseId}`, description: exp.description, cost: exp.cost, quantity: exp.quantity, timestamp: exp.timestamp || new Date().toISOString() }
                }));
            }
            await logJobHistory(jobId, "EXPENSES_BULK_UPDATE", `Bulk updated ${expenses.length} expense items.`);
            return response(200, { message: "Bulk expense update successful" });
        }
        if (path.endsWith("/files") && method === "POST") {
            const fileItem = {
                PK: userId,
                SK: `JOB#${jobId}#FILE#${Date.now()}`,
                name: body.name,
                key: body.key,
                tag: body.tag || 'Other',
                timestamp: new Date().toISOString()
            };
            await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: fileItem }));
            await logJobHistory(jobId, "FILE_UPLOADED", `Uploaded file: ${body.name} (${body.tag || 'Other'})`);
            return response(201, { message: "File recorded" });
        }
        if (path.match(/\/jobs\/.*\/items\/.*$/) && method === "DELETE") {
            const itemId = path.split("/").pop();
            const existingItem = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}` } }));
            const itemDesc = existingItem.Item ? existingItem.Item.description : 'Unknown Item';
            await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}` } }));
            await logJobHistory(jobId, "LINE_ITEM_DELETED", `Deleted item "${itemDesc}"`);
            return response(200, { message: "Item deleted" });
        }
        if (path.endsWith("/items") && method === "POST") {
            const itemId = Date.now().toString();
            await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: `JOB#${jobId}#LINE#${itemId}`, ...body } }));
            await logJobHistory(jobId, "LINE_ITEM_ADDED", `Added item "${body.description}" (${body.quantity}x @ $${body.cost})`);
            return response(201, { id: itemId });
        }
        if (path.endsWith("/history") && method === "GET") {
            const result = await docClient.send(new QueryCommand({ TableName: HISTORY_TABLE, KeyConditionExpression: "JobId = :jobId", ExpressionAttributeValues: { ":jobId": jobId }, ScanIndexForward: false }));
            return response(200, result.Items || []);
        }
        if (path.endsWith("/visits") && method === "POST") {
            const visitId = Date.now().toString();
            const visitItem = { PK: userId, SK: `JOB#${jobId}#VISIT#${visitId}`, id: visitId, startDateTime: body.startDateTime, endDateTime: body.endDateTime, notes: body.notes || "", createdAt: new Date().toISOString() };
            await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: visitItem }));
            await logJobHistory(jobId, "VISIT_ADDED", `Scheduled site visit: ${body.startDateTime} to ${body.endDateTime}.`);
            return response(201, { id: visitId });
        }
        if (path.match(/\/jobs\/.*\/files\/.*$/) && method === "DELETE") {
            const fileSkPart = path.split("/").pop();
            const sk = `JOB#${jobId}#FILE#${fileSkPart}`;
            const fileItem = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: sk } }));
            if (fileItem.Item && fileItem.Item.key) {
                await s3Client.send(new DeleteObjectCommand({ Bucket: FILES_BUCKET, Key: fileItem.Item.key }));
            }
            await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: sk } }));
            await logJobHistory(jobId, "FILE_DELETED", `Deleted file: ${fileItem.Item ? fileItem.Item.name : 'Unknown'}`);
            return response(200, { message: "File deleted" });
        }
        if (path.match(/\/jobs\/.*\/visits\/.*$/) && method === "DELETE") {
            const visitId = path.split("/").pop();
            const existingVisit = await docClient.send(new GetCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${jobId}#VISIT#${visitId}` } }));
            const visitNotes = existingVisit.Item ? existingVisit.Item.notes : 'Site Visit';
            await docClient.send(new DeleteCommand({ TableName: DATA_TABLE, Key: { PK: userId, SK: `JOB#${jobId}#VISIT#${visitId}` } }));
            await logJobHistory(jobId, "VISIT_DELETED", `Deleted site visit: ${visitNotes}`);
            return response(200, { message: "Visit deleted" });
        }
    }

    // Chat
    if (path === "/chat" && method === "POST") {
      let messages = body.history || [];
      
      const userContent = [{ text: body.message || "Please process this image." }];
      if (body.imageKey) {
        const getObj = await s3Client.send(new GetObjectCommand({
            Bucket: FILES_BUCKET,
            Key: body.imageKey
        }));
        const bytes = await getObj.Body.transformToByteArray();
        userContent.push({
            image: {
                format: body.imageFormat === 'png' ? 'png' : 'jpeg',
                source: { bytes: bytes }
            }
        });
      }
      
      messages.push({ role: "user", content: userContent });

      let system = [{text:"You are a professional handyman project management assistant. If a user uploads an image of a receipt, use the 'log_expense_from_receipt' tool to extract the details and log it. You can also manage jobs, customers, site visits, and estimates using other tools. Always ask for clarification if needed."}];
      if(body.jobId) system.push({text:"You are currently in the context of job ID: "+body.jobId+". Always pass this jobId to tool calls."});
      
      let finalMessage = "";
      for (let i = 0; i < 3; i++) {
        try {
            const command = new ConverseCommand({ modelId: "amazon.nova-lite-v1:0", messages: messages, system:system, toolConfig: { tools } });
            const result = await bedrockClient.send(command);
            const outputMessage = result.output.message;
            messages.push(outputMessage);
            
            if (result.stopReason === "tool_use") {
              const toolResults = [];
              for (const content of outputMessage.content) {
                if (content.toolUse) {
                  const toolOutput = await handleToolUse(userId, content.toolUse, body.jobId);
                  toolResults.push({ toolResult: { toolUseId: content.toolUse.toolUseId, content: [{ text: toolOutput }] } });
                }
              }
              messages.push({ role: "user", content: toolResults });
            } else {
              finalMessage = outputMessage.content.find(c => c.text)?.text || "Done.";
              break;
            }
        } catch (err) {
            console.error("Bedrock Converse error:", err);
            throw err;
        }
      }
      return response(200, { message: finalMessage, history: messages });
    }

    // Settings
    if (path === "/settings") {
        if (method === "GET") {
            const waveToken = await getSetting(userId, "WAVE_TOKEN");
            const businessId = await getSetting(userId, "WAVE_BUSINESS_ID");
            const companyName = await getSetting(userId, "COMPANY_NAME");
            const companyLogoKey = await getSetting(userId, "COMPANY_LOGO_KEY");
            const invoiceNotes = await getSetting(userId, "INVOICE_NOTES");
            
            let companyLogoUrl = null;
            if (companyLogoKey) {
                companyLogoUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: FILES_BUCKET, Key: companyLogoKey }), { expiresIn: 3600 });
            }
            return response(200, { waveToken, businessId, companyName, companyLogoUrl, invoiceNotes });
        }
        if (method === "POST") {
            if (body.waveToken !== undefined) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#WAVE_TOKEN", value: body.waveToken } }));
            if (body.businessId !== undefined) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#WAVE_BUSINESS_ID", value: body.businessId } }));
            if (body.companyName !== undefined) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#COMPANY_NAME", value: body.companyName } }));
            if (body.companyLogoKey !== undefined) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#COMPANY_LOGO_KEY", value: body.companyLogoKey } }));
            if (body.invoiceNotes !== undefined) await docClient.send(new PutCommand({ TableName: DATA_TABLE, Item: { PK: userId, SK: "SETTING#INVOICE_NOTES", value: body.invoiceNotes } }));
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
