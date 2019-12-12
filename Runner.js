/*******************************************************************************
Copyright 2019 Jessica Pennell

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*******************************************************************************/
var assert = require('assert'),
  async = require('async'),
  fs = require('fs'),
  newman = require('newman'),
  path = require('path'),
  printf = require('sprintf-js');
  tmp = require('tmp'),
  url = require('url'),
  uuid = require('uuid/v5'),
  yargs = require('yargs');

tmp.setGracefulCleanup();
function noop() { }
function passerr(err) { if(err) {throw err;} }

/** Used for generating UUIDs needed by Postman */
const TESTURI = "http://github.com/iheartdaikaiju/postman_tools";

/**
 * Run all tests with all passed in args
 */
class Runner {
  constructor(testfile, datafile) {
    /** Contains the tests to run */
    this.testfile = testfile;

    /** Contains test data from the database */
    this.datafile = datafile;

    /** A temporary directory used to store env files */
    this.tmpDir = tmp.dirSync({mode: 750, prefix: 'ExampleTest'});

    /** A list of prepped test environments, which launch asynchronously */
    this.environments = [];
  }

  /**
   * Set up queue for controlling async access to test environments
   *
   * @param size once size elements are reached, queue will drain
   */
  initQueue(size) {
    function worker(nextEnv) {
      this.environments.push(nextEnv);
    }
    function handleDrain() {
      this.drainflag = 1;
    }
    this.q = async.queue(worker.bind(this), size);
    this.q.drain(handleDrain.bind(this));
    this.drainFlag = 0;
  }

  /** Add a test environment to the queue */
  enqueue(nextEnv)
  {
    this.q.push(nextEnv);
  }

  /** Remove a test environment from the queue once queue is full */
  dequeue()
  {
    // wait until queue is fully populated before dequeueing
    function testfunc() {
      return this.drainflag == 1;
    }
    async.until(testfunc.bind(this), noop, noop);

    return this.environments.pop();
  }

  /**
   * Runs a separate postman instance for every URI arg
   *
   * @param arg1{1, 2, ...}: arg(s) to append to URI
   */
  runSuite(arg1 /*, arg1, ...*/) {
    this.initQueue(arguments.length);
    Array.prototype.slice.call(arguments, 0).forEach(this.prep, this);
  }

  /**
   * Create an environment object for a single test run,
   * then prepare an environment file in the filesystem.
   * Once created, will execute test with a prepped environment.
   *
   * @param arg arg to append to URI
   */
  prep(arg, i) {
    var envFileArgs = {
      mode: 644,
      dir : this.tmpDir.name,
      postfix: '.json',
    };
    var env = new Environment(arg, this.testfile, this.datafile);

    this.enqueue(env);
    tmp.file(envFileArgs, env.launch.bind(this));
  }
}

/**
 * Preps an environment file with per-run arguments,
 * then launches Postman with this file
 *
 * This should be overloaded for the test suite in question
 */
class Environment {
  constructor(arg, testfile, datafile) {
    /** Arg to append to test URI */
    this.arg = arg;

    /** stores UUID needed by postman */
    this.testid = uuid(url.resolve(TESTURI, arg.toString()), uuid.DNS);

    /** File containing test script (full path) */
    this.testfile = testfile;

    /** File containing test data from the db (full path) */
    this.datafile = datafile;
  }

  /**
   * Body of environment document, populated with this thread's arg
   *
   * @returns body of the env file
   */
  envBody() {
    var now = new Date().toISOString();
    var template = '%s', header;

    if(fs.existsSync(argv.template))
    {
      template = fs.readFileSync(argv.template, 'ascii', passerr);
    }
    header = `
{
  "id": "${this.testid}",
  "name": "ExampleKey",
  "values": [
`
    var footer = `
  ],
  "_postman_variable_scope": "globals",
  "_postman_exported_at": "${now}",
  "_postman_exported_using": "Postman/6.7.4"
}
`
    return printf.sprintf(header + template + footer, this.arg).trim();
  }

  /**
   * Asynchronous handler which launches a single Postman test run,
   * blocking within its own thread
   *
   * @param err exists if temp file storing env file could not be created
   * @param path path to temp file storing env file contents
   * @param fd file descriptor for temp file storing env file contents
   * @param cleanupCallback run after postman is done to destroy env file
   */
  launch(err, path, fd, cleanupCallback) {
    passerr(err);
    var env = this.dequeue();

    assert(fs.existsSync(path));
    fs.appendFile(path, env.envBody(), passerr );
    new Thread(path, env.testfile, env.datafile).run();
  }
}

/**
 * A single thread running Postman with a specified envFile
 */
class Thread {
  constructor(envFile, testFile, datafile) {
    /** Postman environment file containing all env vars */
    this.envFile = envFile;

    /** File containing test script (full path) */
    this.testFile = testFile;

    /** Contains test data from the database */
    this.datafile = datafile;
  }

  /** Execute Postman using this thread's environment file */
  run() {
    var params = {
      collection: this.testFile,
      environment: this.envFile,
      timeout: argv.timeout,
    };

    assert(fs.existsSync(this.testFile));
    assert(fs.existsSync(this.envFile));

    if(fs.existsSync(this.datafile)) {
      params.iterationData = this.datafile;
    }

    if(verbose) {
      console.log('newman.run(' + JSON.stringify(params) + ', new Thread().handleResponse(err, response))');
    }

    newman.run(params, this.handleResponse.bind(this));
  }

  /** Get response from Postman and act on it */
  handleResponse(err, response) {
    function onError(err) {
      if(! err) {
        return;
      }

      // timeouts are treated as test failures
      if(err.message.match(/callback timed out/)) {
        console.log(`Results for ${path.basename(this.testFile)}: suite failure, time ${argv.timeout} ms exceeded`);
        return;
      }

      // fully populate stack before throwing exception
      try {
        throw new Error(err.message, err.fileName, err.lineNumber);
      }
      catch (hrerr) {
        passerr(hrerr);
      }
    }
    onError = onError.bind(this);
    onError(err);

    var failed = response.run.stats.assertions.failed;
    var total = response.run.stats.assertions.total;
    var executions = response.run.executions;

    /** Get test failure summary from Postman response and act on it */
    function handleAssertion(assertion, i) {
      if (assertion.error && ! quiet) {
        console.log(JSON.stringify(assertion, null, 2));
      }
    }

    /** Handle any errors that came up */
    function handleError(testScript, i) {
      if (testScript.error) {
        var err = testScript.error;
        throw new Error(err.message, err.fileName, err.lineNumber);
      }
    }

    /** Get test results from Postman response and act on it */
    function handleTestResult(execution, i) {
      var request = execution.request;
      var proto = request.url.protocol + '://';
      var host = request.url.host.join('.');
      var path = request.url.path.join('/');
      var URI = url.resolve(proto + host, path);
      var body = JSON.stringify(request.body);
      var method = request.method;
      var results = JSON.parse(execution.response.stream).Results;
      var assertions = execution.assertions;
      var testScripts = execution.testScript || [];
      var item = execution.item;
      var testname = item.name;
      var result, j;

      if (verbose) {
        console.log(testname);
        console.log(`Request : URI ${URI}, body ${body}, method ${method}`);
        if (results === null || results === undefined || results.length === 0) {
          console.log('No results in body');
        }
        else {
          for(j = 0; j < results.length; j++) {
            result = results[j];
            console.log(`Result ${j} :\n${JSON.stringify(result, null, 2)}`);
          }
        }
      }

      if (! quiet) {
        console.log(path);
      }
      testScripts.forEach(handleError.bind(this));
      assertions.forEach(handleAssertion);
    }

    executions.forEach(handleTestResult);
    console.log(`Results for ${path.basename(this.testFile)}: ${failed} failed, ${total-failed} passed, ${total} total`);
  }
}

/** Executable section */

/** Command line switches */
const defaultArg = {
  folder : '',
  globals : [],
  quiet : false,
  template : '',
  testfiles : [],
  verbose : false,
}
const argv = require.main === module
  ? yargs
    .default('folder', 'ExampleFolder')
    .default('homedir', path.join(__dirname))
    .option('verbose', {
        alias: 'v',
        description: 'print response along with test results',
        type: 'boolean',
      })
    .option('quiet', {
        alias: 'q',
        description: 'suppress all output but Results line',
        type: 'boolean',
      })
    .option('testfiles', {
        description: 'Postman collections containing tests for each ID',
        type: 'array',
      })
    .check(function(argv, options) {
        var validated = [], testfile;
        while(argv.testfiles.length > 0) {
          testfile = argv.testfiles.pop();
          if (! testfile) {
            continue;
          }
          if (fs.existsSync(testfile)) {
            validated.push(testfile);
          }
          else {
            testfile = path.join(argv.homedir, argv.folder, testfile);
            if (fs.existsSync(testfile)) {
              validated.push(testfile);
            }
          }
        }
        for(i = 0; i < validated.length; i++) {
          testfile = validated.pop();
          argv.testfiles.push(testfile);
        }
        return argv.testfiles.length > 0;
      })
    .option('globals', {
        description: 'Parameter passed to each test collection\'s template',
        type: 'array',
        default: 1,
      })
    .option('template', {
        description: `
A JSON file containing the body of a single member of a Postman Environments
collection's values array, with %s occuring once per file.
Each member of globals will replace %s in a single test run when using the
command line instead of a datafile to test.

If not provided, and globals are provided, the template string '%s' will be used
(in other words you can simply provide the entire value body as a globals arg)

Example :
template.json :
  {
    "key": "tribute",
    "value": "%s",
    "type": "text",
    "description": "not the best song in the world, just a tribute to it",
    "enabled": true
  }
command line :
  node Runner.js --testfiles Tenacious.json D.json --globals 'Beelzaboss' 'Kickapoo' --template template.json --folder ThePickOfDestiny
  Challenge/Beelzaboss
  Challenge/Kickapoo
  Results for Tenacious.json: 0 failed, 4 passed, 4 total
  Challenge/Beelzaboss
  {
    "assertion": "Validate worthiness",
    "skipped": false,
    "error": {
      "name" : "AssertionError",
      "index": 0,
      "test": "Validate worthiness",
      "message": "expected 'Gage' to deeply equal 'a rock and roll legend'",
      "stack": "AssertionError: expected 'Gage' to deeply equal 'a rock and roll legend' at Object.eval sandbox-script.js:1:1)"
    }
  }
  Challenge/Kickapoo
  Results for D.json : 1 failed, 1 passed, 2 total
`,
        type : 'string',
      })
    .option('datafile', {
        description: 'Test data from the database used by all tests',
        type: 'string',
      })
    .check(function(argv, options) {
        var datafile = argv.datafile
          ? fs.existsSync(argv.datafile)
          ? argv.datafile
          : path.join(argv.homedir, argv.folder, argv.datafile)
          : '' ;
        var template = argv.template
          ? fs.existsSync(argv.template)
          ? argv.template
          : path.join(argv.homedir, argv.folder, argv.template)
          : '' ;
        if (! fs.existsSync(datafile) && argv.globals.length < 1) {
          throw "must either specify datafile, or globals for command line";
        }
        if (template && ! fs.existsSync(template)) {
          throw `specified template ${argv.template} not found`;
        }
        argv.datafile = datafile;
        argv.template = template;
        return true;
      })
    .option('timeout', {
        description: 'Specify the time (in milliseconds) to wait for requests to return a response',
        type: 'number',
        default: 30000,
      })
    .argv
  : defaultArg ;

/** Command line args used outside main */
var verbose = argv.verbose;
var quiet = argv.quiet;

/** Run an individual test located inside argv.homedir/folder with parameters */
function runtest(testfile, i) {
  new Runner (testfile, argv.datafile).runSuite(... argv.globals);
}
function main() {
  argv.testfiles.forEach(runtest);
}
if (require.main === module) {
  main();
}
